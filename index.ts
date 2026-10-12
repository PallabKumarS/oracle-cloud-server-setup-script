import * as fs from "node:fs";
import * as path from "node:path";
import * as dotenv from "dotenv";
import * as common from "oci-common";
import * as core from "oci-core";
import * as identity from "oci-identity";

import { resolveAvailabilityDomain } from "./src/ad-resolver.js";
import { getActiveAccountConfigs, getAuthProvider } from "./src/auth-provider.js";
import { type AttemptResult, DiscordNotifier } from "./src/discord-notifier.js";
import { resolveImageId } from "./src/image-resolver.js";
import { createLaunchDetails } from "./src/launch-details-builder.js";
import { setupLogFilter } from "./src/logger-filter.js";
import { resolveSubnet } from "./src/network-resolver.js";
import { isEmailConfigured, resolveRecipientEmail, sendServerCreatedEmail } from "./src/sendMail.js";
import type { AccountConfig, InstanceRecord, LaunchConfig } from "./src/types.js";
import { fetchVnicIps } from "./src/vnic-helper.js";

const localEnv = path.resolve(process.cwd(), ".env");
const parentEnv = path.resolve(process.cwd(), "..", ".env");
dotenv.config({ path: fs.existsSync(localEnv) ? localEnv : parentEnv });

setupLogFilter();

const discord = new DiscordNotifier();

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface AccountRuntime {
	config: AccountConfig;
	computeClient: core.ComputeClient;
	networkClient: core.VirtualNetworkClient;
	identityClient: identity.IdentityClient;
	compartmentId: string;
	region: string;
	sshKey: string;
	availabilityDomain: string;
	imageId: string;
	subnetId: string;
	pendingTargets: string[];
	targetIndex: number;
	activeInterval: number;
	isDisabled: boolean;
}

function loadConfig(): LaunchConfig {
	const rawNames =
		process.env.OCI_INSTANCE_NAMES?.trim() ||
		process.env.OCI_INSTANCE_NAME?.trim() ||
		"backend,frontend";

	return {
		targetInstanceNames: rawNames
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean),
		shape: process.env.OCI_SHAPE?.trim() || "VM.Standard.A1.Flex",
		ocpus: Number.parseInt(process.env.OCI_OCPUS || "1", 10),
		memoryInGBs: Number.parseInt(process.env.OCI_MEMORY_IN_GBS || "6", 10),
		bootVolumeSize: Number.parseInt(
			process.env.OCI_BOOT_VOLUME_SIZE_IN_GBS || "100",
			10,
		),
		bootVolumeVpu: Number.parseInt(process.env.OCI_BOOT_VOLUME_VPU || "10", 10),
		configuredFaultDomain: process.env.OCI_FAULT_DOMAIN?.trim(),
		assignPublicIp: process.env.OCI_ASSIGN_PUBLIC_IP !== "false",
		retryInterval: Number.parseInt(
			process.env.OCI_RETRY_INTERVAL_SECONDS || "90",
			10,
		),
	};
}

function loadExistingRecords(stateFilePath: string): InstanceRecord[] {
	if (!fs.existsSync(stateFilePath)) {
		return [];
	}
	try {
		const raw = fs.readFileSync(stateFilePath, "utf8");
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

function saveState(stateFilePath: string, records: InstanceRecord[]) {
	try {
		fs.writeFileSync(stateFilePath, JSON.stringify(records, null, 2), "utf8");
	} catch (err: unknown) {
		console.error("Failed to write state file:", err);
	}
}

async function initializeAccount(
	accConfig: AccountConfig,
	launchConfig: LaunchConfig,
	records: InstanceRecord[],
): Promise<AccountRuntime> {
	console.log(`\nInitializing ${accConfig.label}...`);
	const { provider, compartmentId, region } = getAuthProvider(accConfig.envSuffix);

	const computeClient = new core.ComputeClient(
		{ authenticationDetailsProvider: provider },
		{ retryConfiguration: common.NoRetryConfigurationDetails },
	);
	const networkClient = new core.VirtualNetworkClient({
		authenticationDetailsProvider: provider,
	});
	const identityClient = new identity.IdentityClient({
		authenticationDetailsProvider: provider,
	});

	const availabilityDomain = await resolveAvailabilityDomain(
		identityClient,
		compartmentId,
		accConfig.envSuffix,
	);
	const imageId = await resolveImageId(computeClient, compartmentId, accConfig.envSuffix);
	const subnetId = await resolveSubnet(networkClient, compartmentId, accConfig.envSuffix);

	console.log(`Checking existing instances for ${accConfig.label}...`);
	const existingListRes = await computeClient.listInstances({ compartmentId });
	const activeInstances = existingListRes.items.filter(
		(i) =>
			i.lifecycleState !== core.models.Instance.LifecycleState.Terminated &&
			i.lifecycleState !== core.models.Instance.LifecycleState.Terminating,
	);

	const pendingTargets: string[] = [];

	for (const targetName of launchConfig.targetInstanceNames) {
		const existingMatch = activeInstances.find((i) => i.displayName === targetName);
		if (existingMatch) {
			console.log(
				`[EXISTS] Instance "${targetName}" already active on ${accConfig.label} (OCID: ${existingMatch.id}).`,
			);
			const alreadyRecorded = records.some(
				(r) => r.account === accConfig.label && r.name === targetName,
			);
			if (!alreadyRecorded) {
				records.push({
					account: accConfig.label,
					name: targetName,
					id: existingMatch.id,
					lifecycleState: existingMatch.lifecycleState,
					region: accConfig.region,
					createdAt: existingMatch.timeCreated?.toISOString(),
				});
			}
		} else {
			pendingTargets.push(targetName);
		}
	}

	return {
		config: accConfig,
		computeClient,
		networkClient,
		identityClient,
		compartmentId,
		region,
		sshKey: accConfig.sshKey,
		availabilityDomain,
		imageId,
		subnetId,
		pendingTargets,
		targetIndex: 0,
		activeInterval: launchConfig.retryInterval,
		isDisabled: false,
	};
}

async function handleLaunchSuccess(
	account: AccountRuntime,
	targetName: string,
	instance: core.models.Instance,
	launchConfig: LaunchConfig,
	records: InstanceRecord[],
	stateFilePath: string,
) {
	console.log("\n=======================================================");
	console.log(`   SUCCESS: "${instance.displayName}" CREATED on ${account.config.label}!`);
	console.log("=======================================================");
	console.log(`- Instance Name:    ${instance.displayName}`);
	console.log(`- Account:          ${account.config.label}`);
	console.log(`- Region:           ${account.region}`);
	console.log(`- Instance OCID:    ${instance.id}`);
	console.log(`- Lifecycle State:  ${instance.lifecycleState}`);
	console.log(`- Fault Domain:     ${instance.faultDomain}`);
	console.log(`- Created At:       ${instance.timeCreated}`);
	console.log("=======================================================");

	console.log(`\nWaiting 15 seconds to fetch assigned Public IP for "${targetName}"...`);
	await sleep(15000);

	const { publicIp, privateIp } = await fetchVnicIps(
		account.computeClient,
		account.networkClient,
		account.compartmentId,
		instance.id,
	);

	console.log(`- Public IP:   ${publicIp || "None assigned"}`);
	console.log(`- Private IP:  ${privateIp || "None assigned"}`);
	if (publicIp) {
		console.log(`\nConnect with:\n  ssh ubuntu@${publicIp}\n`);
	}

	const record: InstanceRecord = {
		account: account.config.label,
		name: targetName,
		id: instance.id,
		lifecycleState: instance.lifecycleState,
		publicIp,
		privateIp,
		region: account.region,
		createdAt: instance.timeCreated ? new Date(instance.timeCreated).toISOString() : new Date().toISOString(),
	};
	records.push(record);
	saveState(stateFilePath, records);

	discord.created({
		instanceName: targetName,
		accountLabel: account.config.label,
		region: account.region,
		instanceId: instance.id,
		lifecycleState: instance.lifecycleState,
		faultDomain: instance.faultDomain,
		publicIp,
		privateIp,
	});

	try {
		console.log(`Sending creation email notification to ${recipientEmail}...`);
		await sendServerCreatedEmail({
			instanceName: targetName,
			accountLabel: account.config.label,
			region: account.region,
			instanceId: instance.id,
			lifecycleState: instance.lifecycleState,
			shape: launchConfig.shape,
			ocpus: launchConfig.ocpus,
			memoryInGBs: launchConfig.memoryInGBs,
			bootVolumeSize: launchConfig.bootVolumeSize,
			faultDomain: instance.faultDomain,
			availabilityDomain: account.availabilityDomain,
			publicIp,
			privateIp,
			timeCreated: record.createdAt,
		}, recipientEmail);
		console.log(`Email notification sent successfully to ${recipientEmail}.`);
	} catch (mailErr: unknown) {
		const mailMsg = mailErr instanceof Error ? mailErr.message : String(mailErr);
		console.error(`Failed to send email notification: ${mailMsg}`);
		discord.warn("Email notification failed", mailMsg);
	}
}

function handleLaunchError(
	account: AccountRuntime,
	targetName: string,
	err: unknown,
): AttemptResult {
	const error = err as {
		statusCode?: number;
		serviceCode?: string;
		message?: string;
	};
	const msg = error.message || String(err);
	const code = error.serviceCode || "";
	const status = error.statusCode;

	const isOutOfCapacity =
		status === 500 ||
		code === "InternalError" ||
		code === "OutOfCapacity" ||
		code === "TooManyRequests" ||
		status === 429 ||
		msg.includes("Out of host capacity") ||
		msg.includes("capacity");

	if (isOutOfCapacity) {
		if (msg.includes("Too many requests") || code === "TooManyRequests" || status === 429) {
			account.activeInterval = Math.max(account.activeInterval + 5, 85);
			console.log(`Rate limited on ${account.config.label}. Interval adjusted to ${account.activeInterval}s.`);
			discord.attempt(account.config.label, targetName, "ratelimit");
			return "ratelimit";
		}
		console.log(`Out of host capacity on ${account.config.label} for "${targetName}".`);
		discord.attempt(account.config.label, targetName, "capacity");
		return "capacity";
	}

	console.log(`Failed on ${account.config.label} (Status: ${status}, Code: ${code}): ${msg}`);
	if (status === 400 || status === 401 || status === 404) {
		console.error(
			`[AUTH/CONFIG ERROR] Account ${account.config.label} credentials or parameters rejected. Disabling this account.`,
		);
		account.isDisabled = true;
		discord.attempt(account.config.label, targetName, "error");
		discord.accountDisabled(account.config.label, `Status: ${status}, Code: ${code}\n${msg}`);
	} else {
		discord.attempt(account.config.label, targetName, "error", `Status: ${status}, Code: ${code}\n${msg}`);
	}
	return "error";
}

async function attemptAccountLaunch(
	account: AccountRuntime,
	attemptNumber: number,
	launchConfig: LaunchConfig,
	records: InstanceRecord[],
	stateFilePath: string,
) {
	if (account.isDisabled || account.pendingTargets.length === 0) {
		return;
	}

	const targetName = account.pendingTargets[account.targetIndex % account.pendingTargets.length];
	const faultDomain = launchConfig.configuredFaultDomain;
	const fdLabel = faultDomain || "ANY-FD";
	const timeStr = new Date().toISOString().slice(11, 19);

	process.stdout.write(
		`[#${attemptNumber} | ${account.config.label.padEnd(28)} | ${targetName.padEnd(8)} | ${fdLabel.padEnd(10)} | ${timeStr}] Launching... `,
	);

	const launchRequest = createLaunchDetails({
		targetName,
		faultDomain,
		compartmentId: account.compartmentId,
		availabilityDomain: account.availabilityDomain,
		imageId: account.imageId,
		subnetId: account.subnetId,
		sshKey: account.sshKey,
		config: launchConfig,
	});

	try {
		const res = await account.computeClient.launchInstance(launchRequest);
		discord.attempt(account.config.label, targetName, "created");
		await handleLaunchSuccess(
			account,
			targetName,
			res.instance,
			launchConfig,
			records,
			stateFilePath,
		);
	} catch (err: unknown) {
		handleLaunchError(account, targetName, err);
	} finally {
		account.targetIndex++;
	}
}

async function main() {
	console.log("\n==================================================================");
	console.log("   Oracle Cloud (OCI) Multi-Account VM Always Free Auto-Launcher  ");
	console.log("==================================================================\n");

	const launchConfig = loadConfig();
	const accountConfigs = getActiveAccountConfigs();

	if (accountConfigs.length === 0) {
		console.error("No valid OCI accounts detected in environment variables.");
		process.exit(1);
	}

	const stateFilePath = path.resolve(process.cwd(), "created_instances.json");
	const records: InstanceRecord[] = loadExistingRecords(stateFilePath);

	const accounts: AccountRuntime[] = [];
	for (const accConfig of accountConfigs) {
		const runtime = await initializeAccount(accConfig, launchConfig, records);
		accounts.push(runtime);
	}

	saveState(stateFilePath, records);

	console.log("\n=======================================================");
	console.log("   Launcher Configuration Summary:                     ");
	console.log("=======================================================");
	console.log(`- Target Instances:   ${launchConfig.targetInstanceNames.join(", ")}`);
	console.log(`- Configured Shape:   ${launchConfig.shape} (${launchConfig.ocpus} OCPU, ${launchConfig.memoryInGBs} GB RAM)`);
	console.log(`- Boot Volume:        ${launchConfig.bootVolumeSize} GB (VPU: ${launchConfig.bootVolumeVpu})`);
	console.log(`- Base Retry Delay:   ${launchConfig.retryInterval} seconds`);
	console.log(`- Active Accounts:    ${accounts.length}`);
	for (const acc of accounts) {
		console.log(`  * ${acc.config.label} (Pending: [${acc.pendingTargets.join(", ")}])`);
	}
	console.log("=======================================================\n");

	if (discord.enabled) {
		console.log("Discord notifications enabled (DISCORD_WEBHOOK_URL).\n");
	}
	discord.started({
		targets: launchConfig.targetInstanceNames,
		shape: launchConfig.shape,
		ocpus: launchConfig.ocpus,
		memoryInGBs: launchConfig.memoryInGBs,
		bootVolumeSize: launchConfig.bootVolumeSize,
		bootVolumeVpu: launchConfig.bootVolumeVpu,
		retryInterval: launchConfig.retryInterval,
		accounts: accounts.map((a) => ({
			label: a.config.label,
			region: a.region,
			pending: a.pendingTargets,
			existing: launchConfig.targetInstanceNames.filter((n) => !a.pendingTargets.includes(n)),
		})),
	});

	const totalPending = accounts.reduce((sum, a) => sum + a.pendingTargets.length, 0);
	if (totalPending === 0) {
		console.log("All target instances are already created across configured accounts.");
		console.log(`State recorded in: ${stateFilePath}`);
		discord.allProvisioned(records);
		await discord.flush();
		return;
	}

	let attemptRound = 1;

	while (accounts.some((a) => !a.isDisabled && a.pendingTargets.length > 0)) {
		const activeAccounts = accounts.filter((a) => !a.isDisabled && a.pendingTargets.length > 0);

		console.log(
			`\n--- [Cycle #${attemptRound}] Executing parallel API calls for ${activeAccounts.length} account(s) ---`,
		);

		for (const acc of activeAccounts) {
			await attemptAccountLaunch(acc, attemptRound, launchConfig, records, stateFilePath);
			// 1 second stagger between account calls to prevent stdout interleaving
			await sleep(1000);
		}

		const remainingPending = accounts.reduce((sum, a) => sum + (a.isDisabled ? 0 : a.pendingTargets.length), 0);
		if (remainingPending === 0) {
			console.log("\nAll pending instances have been successfully provisioned!");
			break;
		}

		const waitInterval = Math.max(...activeAccounts.map((a) => a.activeInterval), launchConfig.retryInterval);
		console.log(`Cycle #${attemptRound} completed. Waiting ${waitInterval}s before next attempt round...`);
		discord.cycleCompleted(attemptRound, waitInterval);
		attemptRound++;
		await sleep(waitInterval * 1000);
	}

	console.log("\n=======================================================");
	console.log("   ALL TARGET INSTANCES SUCCESSFULLY PROVISIONED!      ");
	console.log("=======================================================");
	for (const rec of records) {
		console.log(
			`- [${rec.account}] ${rec.name.padEnd(12)} | IP: ${(rec.publicIp || "Pending").padEnd(16)} | OCID: ${rec.id || "N/A"}`,
		);
	}
	console.log("=======================================================\n");
	console.log(`Saved provisioning summary to: ${stateFilePath}`);
	discord.allProvisioned(records);
	await discord.flush();
}

main().catch(async (err) => {
	console.error("\nUnexpected fatal error:", err);
	discord.fatal(err);
	await discord.flush();
	process.exit(1);
});
