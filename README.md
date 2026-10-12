# Oracle Cloud Infrastructure (OCI) ARM VM Multi-Account Auto-Launcher

Continuous, automated OCI ARM instance launcher designed for Oracle Cloud Always Free tier (`VM.Standard.A1.Flex`). Supports simultaneous multi-account / multi-region retry queues, automatic network provisioning, dynamic image resolution, and automated email notifications when instances are created.

---

## Overview & Architecture

Oracle Cloud Always Free tier provides up to 4 OCPUs and 24 GB of RAM on Ampere A1 ARM compute shapes, plus 200 GB of free boot volume storage. However, high demand often results in `Out of host capacity` (HTTP 500) errors in popular regions such as Singapore (`ap-singapore-1`) and Sydney (`ap-sydney-1`).

This tool solves this by running an automated, resilient retry loop across multiple accounts and regions in parallel:

```
+-------------------------------------------------------------------------+
|                    OCI Multi-Account Auto-Launcher                      |
+-------------------------------------------------------------------------+
                                     |
       +-----------------------------+-----------------------------+
       |                                                           |
       v                                                           v
[Account 1: ap-singapore-1]                                [Account 2: ap-sydney-1]
- Check Existing Targets                                   - Check Existing Targets
- Resolve AD, Subnet, Image                                - Resolve AD, Subnet, Image
       |                                                           |
       v                                                           v
[Launch Call: backend / frontend]                          [Launch Call: backend / frontend]
       |                                                           |
       +-----------------------------+-----------------------------+
                                     |
                                     v
                        Provisioning Decision Engine
                       /                            \
             [Out of Capacity]                    [Success: 200 OK]
                     |                                    |
            Smart Backoff Delay                  Wait 15s for VNIC IP
                     |                                    |
             Repeat next cycle                   Send Email via SMTP
                                                          |
                                                 Save created_instances.json
```

---

## Key Features

1. **Multi-Account & Multi-Region Support:**
   - Run dual parallel launch requests across multiple accounts/regions in each cycle (e.g. Account 1 in Singapore, Account 2 in Sydney).
   - Independent queue tracking per account for multiple target VMs (e.g. `backend` and `frontend`).

2. **Automated Resource Resolution:**
   - **Availability Domain:** Queries and binds to available ADs automatically.
   - **OS Image Resolution:** Automatically queries and selects the latest Canonical Ubuntu 24.04 ARM (`aarch64`) image in the account's region.
   - **Networking:** Detects existing public subnets. If none exist, automatically creates a dedicated VCN (`10.0.0.0/16`), Internet Gateway, route table, security list (opening SSH port 22 and ICMP), and public subnet (`10.0.0.0/24`).

3. **Smart Rate Limiting & Capacity Backoff:**
   - Gracefully handles `Out of host capacity` and `TooManyRequests` (HTTP 429) errors.
   - Automatically increases polling delay when rate-limited to avoid bucket starvation.

4. **Instant Email Notifications:**
   - Integrated Gmail SMTP notification service via `src/sendMail.ts`.
   - Sends a formatted HTML email containing the instance name, account, region, assigned public IP, private IP, OCID, and SSH connection command as soon as a VM is provisioned.

5. **Discord Notifications (Optional):**
   - Set `DISCORD_WEBHOOK_URL` to enable. Implemented in `src/discord-notifier.ts` with zero extra dependencies.
   - Posts a single **live status card** that is edited in place after every retry cycle: cycle number, attempt and out-of-capacity counters, per-account / per-instance status, and a countdown to the next attempt. Your channel doesn't get flooded with one message per retry.
   - Sends separate rich embeds only for real events: launcher started, **VM created** (public/private IP, ready-to-copy `ssh` command, OCID), launch errors, account disabled, email failure, all instances provisioned, and fatal crashes.
   - Respects Discord rate limits, and never interrupts the launcher if Discord is unreachable.

6. **State Persistence:**
   - Tracks created instances in `created_instances.json` to prevent duplicate launches across restarts.

---

## Specifications (Always Free Tier)

Default configuration allocates the Always Free quota into two dedicated virtual machines:

| Parameter | Backend VM | Frontend VM | Combined Total |
| :--- | :--- | :--- | :--- |
| **Shape** | `VM.Standard.A1.Flex` | `VM.Standard.A1.Flex` | Ampere A1 Flex |
| **OCPUs** | 1 core | 1 core | 2 / 4 cores |
| **Memory** | 6 GB RAM | 6 GB RAM | 12 / 24 GB RAM |
| **Boot Volume** | 100 GB | 100 GB | 200 / 200 GB |
| **Volume Performance** | 10 VPU (Balanced) | 10 VPU (Balanced) | Balanced |
| **Operating System** | Ubuntu 24.04 ARM | Ubuntu 24.04 ARM | Canonical Minimal |
| **Cost** | Free ($0.00) | Free ($0.00) | 100% Free Tier |

---

## Prerequisites

- [Node.js](https://nodejs.org/) v18+ or v20+
- An Oracle Cloud Infrastructure (OCI) account with API Key access
- An SSH key pair (`id_rsa.pub` or `id_ed25519.pub`)
- (Optional) Gmail App Password for email notifications

---

## Setup & Configuration

### 1. Clone Repository & Install Dependencies

```bash
git clone https://github.com/PallabKumarS/oracle-cloud-server-setup-script.git
cd oracle-cloud-server-setup-script
npm install
```

### 2. Generate OCI API Keys

1. Log in to the [Oracle Cloud Console](https://cloud.oracle.com/).
2. In the top-right corner, click **Profile** -> **User Settings** (or **My Profile**).
3. Under **Resources** on the left, click **API Keys**.
4. Click **Add API Key** -> **Generate API Key Pair** -> **Download Private Key** (`.pem`).
5. Click **Add**.
6. Place the downloaded `.pem` file inside the project directory:
   - Primary Account: `./oci_private_key.pem`
   - Secondary Account (if applicable): `./oci_private_key2.pem`

### 3. Configure Environment Variables

Copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

Edit `.env` with your credentials:

```env
# Account 1 (Primary - e.g. Singapore)
OCI_USER_OCID=ocid1.user.oc1..aaaaaaaaxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
OCI_TENANCY_OCID=ocid1.tenancy.oc1..aaaaaaaaxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
OCI_FINGERPRINT=xx:xx:xx:xx:xx:xx:xx:xx:xx:xx:xx:xx:xx:xx:xx:xx
OCI_REGION=ap-singapore-1
OCI_PRIVATE_KEY_PATH=./oci_private_key.pem
OCI_SSH_PUBLIC_KEY="ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQC..."

# Account 2 (Secondary - e.g. Sydney / Multi-Region)
OCI_USER_OCID2=ocid1.user.oc1..aaaaaaaaxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
OCI_TENANCY_OCID2=ocid1.tenancy.oc1..aaaaaaaaxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
OCI_FINGERPRINT2=xx:xx:xx:xx:xx:xx:xx:xx:xx:xx:xx:xx:xx:xx:xx:xx
OCI_REGION2=ap-sydney-1
OCI_PRIVATE_KEY_PATH2=./oci_private_key2.pem
OCI_SSH_PUBLIC_KEY2="ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQC..."

# Target Instances & Specs
OCI_INSTANCE_NAMES=backend,frontend
OCI_SHAPE=VM.Standard.A1.Flex
OCI_OCPUS=1
OCI_MEMORY_IN_GBS=6
OCI_BOOT_VOLUME_SIZE_IN_GBS=100
OCI_BOOT_VOLUME_VPU=10
OCI_RETRY_INTERVAL_SECONDS=90

# Email Alerts
SENDER_EMAIL=your-email@gmail.com
SENDER_APP_PASS=your-google-app-password
RECIPIENT_EMAIL=your-recipient-email@gmail.com

# Discord Alerts (Optional)
# Server Settings -> Integrations -> Webhooks -> New Webhook -> Copy Webhook URL
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/<id>/<token>
```

---

## Search Parameters & Auto-Resolution

| Parameter | Configuration Variable | Fallback / Resolution Strategy |
| :--- | :--- | :--- |
| **Availability Domain** | `OCI_AVAILABILITY_DOMAIN` | Queries `identityClient.listAvailabilityDomains()`, selects `AD-1` or first available. |
| **Ubuntu 24.04 Image** | `OCI_IMAGE_OCID` | Queries `computeClient.listImages()` for OS `Canonical Ubuntu` and shape `VM.Standard.A1.Flex`, filters for `24.04`, `Minimal`, and `aarch64`. |
| **Subnet & VCN** | `OCI_SUBNET_OCID` | Searches `networkClient.listSubnets()` for names matching `subnet-nodejs` or `public`. If none exist, provisions VCN `10.0.0.0/16` and Subnet `10.0.0.0/24`. |
| **Fault Domain** | `OCI_FAULT_DOMAIN` | If omitted, submits request across all fault domains simultaneously to maximize chance of allocation. |

---

## Verification & Usage

### 1. Verify Connectivity & Credentials

Run the pre-flight check across all configured accounts:

```bash
npm run check-env
```

This verifies API authentication, prints available Availability Domains, checks VCNs/Subnets, queries Ubuntu images, and validates existing instances for each account.

### 2. Start the Launcher

```bash
npm start
```

Output:
```
==================================================================
   Oracle Cloud (OCI) Multi-Account VM Always Free Auto-Launcher  
==================================================================

Initializing Account 1 (ap-singapore-1)...
Initializing Account 2 (ap-sydney-1)...

--- [Cycle #1] Executing parallel API calls for 2 account(s) ---
[#1 | Account 1 (ap-singapore-1)   | backend  | ANY-FD     | 16:20:00] Launching... Out of host capacity on Account 1 for "backend".
[#1 | Account 2 (ap-sydney-1)      | backend  | ANY-FD     | 16:20:01] Launching... Out of host capacity on Account 2 for "backend".
Cycle #1 completed. Waiting 90s before next attempt round...
```

When capacity is found:
```
=======================================================
   SUCCESS: "backend" CREATED on Account 2 (ap-sydney-1)!
=======================================================
- Instance Name:    backend
- Account:          Account 2 (ap-sydney-1)
- Region:           ap-sydney-1
- Instance OCID:    ocid1.instance.oc1.ap-sydney-1.xxxx
- Public IP:        140.238.xxx.xxx
- Private IP:       10.0.0.5

Connect with:
  ssh ubuntu@140.238.xxx.xxx

Sending creation email notification to pallabkumar26@gmail.com...
Email notification sent successfully to pallabkumar26@gmail.com.
```

---

## Project Structure

```
oracle-cloud-server-setup-script/
├── index.ts                      # Core multi-account orchestrator and retry loop
├── check-env.ts                  # Pre-flight environment and credential validator
├── tsconfig.json                 # TypeScript compiler configuration
├── package.json                  # Dependencies and execution scripts
├── .env.example                  # Template for environment configuration
├── .gitignore                    # Protects private keys and local secrets
└── src/
    ├── types.ts                  # Strong TypeScript interfaces and configurations
    ├── auth-provider.ts          # Multi-account OCI authentication and key loading
    ├── launch-details-builder.ts # OCI Compute launch instance payload builder
    ├── network-resolver.ts       # Subnet and VCN discovery / auto-creation
    ├── image-resolver.ts         # Canonical Ubuntu 24.04 ARM image resolution
    ├── ad-resolver.ts            # Availability Domain resolution
    ├── vnic-helper.ts            # Public and private IP resolution helper
    ├── logger-filter.ts          # Terminal logging filter
    ├── sendMail.ts               # Gmail SMTP alert dispatcher
    └── discord-notifier.ts       # Optional Discord webhook status card and alerts
```

---

## License

MIT
