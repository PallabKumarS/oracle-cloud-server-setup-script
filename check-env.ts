import * as fs from "node:fs";
import * as path from "node:path";
import * as dotenv from "dotenv";
import * as common from "oci-common";
import * as core from "oci-core";
import * as identity from "oci-identity";
import { getActiveAccountConfigs, getAuthProvider } from "./src/auth-provider.js";

const localEnvPath = path.resolve(process.cwd(), ".env");
const parentEnvPath = path.resolve(process.cwd(), "..", ".env");
if (fs.existsSync(localEnvPath)) {
	dotenv.config({ path: localEnvPath });
} else if (fs.existsSync(parentEnvPath)) {
	dotenv.config({ path: parentEnvPath });
} else {
	dotenv.config();
}

console.log("\n=======================================================");
console.log("   Oracle Cloud (OCI) Environment & Credential Check   ");
console.log("=======================================================\n");

async function checkAccount(envSuffix: string, label: string) {
	console.log(`\n-------------------------------------------------------`);
	console.log(`   Verifying ${label}`);
	console.log(`-------------------------------------------------------`);

	const { provider, compartmentId, region } = getAuthProvider(envSuffix);
	console.log(`[OCI] Region: ${region}`);
	console.log(`[OCI] Tenancy / Compartment: ${compartmentId.slice(0, 30)}...`);

	const identityClient = new identity.IdentityClient({
		authenticationDetailsProvider: provider,
	});
	const computeClient = new core.ComputeClient({
		authenticationDetailsProvider: provider,
	});
	const networkClient = new core.VirtualNetworkClient({
		authenticationDetailsProvider: provider,
	});

	console.log("\n[1/5] Checking Availability Domains...");
	try {
		const adResp = await identityClient.listAvailabilityDomains({ compartmentId });
		const ads = adResp.items || [];
		for (const ad of ads) {
			console.log(`  Found AD: ${ad.name}`);
		}
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		console.error(`  Failed to list Availability Domains: ${msg}`);
		return;
	}

	console.log("\n[2/5] Checking Virtual Cloud Networks (VCNs) & Subnets...");
	try {
		const vcnResp = await networkClient.listVcns({ compartmentId });
		const vcns = vcnResp.items || [];
		console.log(`  Found ${vcns.length} VCN(s):`);
		for (const vcn of vcns) {
			console.log(`  - VCN "${vcn.displayName}" (${vcn.id}) [CIDR: ${vcn.cidrBlock}]`);
		}

		const subnetResp = await networkClient.listSubnets({ compartmentId });
		const subnets = subnetResp.items || [];
		console.log(`  Found ${subnets.length} Subnet(s):`);
		for (const subnet of subnets) {
			console.log(`  - Subnet "${subnet.displayName}" (${subnet.id}) [CIDR: ${subnet.cidrBlock}]`);
		}
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		console.error(`  Failed to list network resources: ${msg}`);
	}

	console.log("\n[3/5] Searching for Canonical Ubuntu 24.04 ARM images...");
	try {
		const imgResp = await computeClient.listImages({
			compartmentId,
			shape: "VM.Standard.A1.Flex",
			operatingSystem: "Canonical Ubuntu",
		});
		const images = imgResp.items || [];
		const minimal2404 = images.find(
			(img) =>
				img.displayName?.includes("24.04") &&
				img.displayName?.includes("Minimal") &&
				img.displayName?.includes("aarch64"),
		);

		if (minimal2404) {
			console.log(`  Found minimal image:\n    "${minimal2404.displayName}" (${minimal2404.id})`);
		} else {
			const matching = images.filter(
				(img) =>
					img.displayName?.includes("Ubuntu") &&
					img.displayName?.includes("24.04") &&
					img.displayName?.includes("aarch64"),
			);
			for (const img of matching.slice(0, 3)) {
				console.log(`  - "${img.displayName}" (${img.id})`);
			}
		}
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		console.error(`  Failed to query images: ${msg}`);
	}

	console.log("\n[4/5] Checking SSH Key...");
	const sshKey =
		process.env[`OCI_SSH_PUBLIC_KEY${envSuffix}`]?.trim() ||
		process.env.OCI_SSH_PUBLIC_KEY?.trim() ||
		"";

	if (sshKey) {
		console.log(`  SSH key detected: ${sshKey.slice(0, 35)}...`);
	} else {
		console.warn("  No SSH public key found.");
	}

	console.log("\n[5/5] Checking Existing Compute Instances...");
	try {
		const instances = await computeClient.listInstances({ compartmentId });
		const active = instances.items.filter(
			(i) =>
				i.lifecycleState !== core.models.Instance.LifecycleState.Terminated &&
				i.lifecycleState !== core.models.Instance.LifecycleState.Terminating,
		);
		if (active.length === 0) {
			console.log("  No active compute instances currently running.");
		} else {
			console.log(`  Found ${active.length} active instance(s):`);
			for (const inst of active) {
				console.log(`  - "${inst.displayName}" (${inst.shape}) - State: ${inst.lifecycleState}`);
			}
		}
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		console.log(`  Unable to list instances: ${msg}`);
	}
}

async function main() {
	const accounts = getActiveAccountConfigs();
	if (accounts.length === 0) {
		console.error("No OCI accounts configured in environment variables.");
		process.exit(1);
	}

	console.log(`Detected ${accounts.length} OCI account configuration(s):`);
	for (const acc of accounts) {
		console.log(`  - ${acc.label} (suffix: "${acc.envSuffix}")`);
	}

	for (const acc of accounts) {
		await checkAccount(acc.envSuffix, acc.label);
	}

	console.log("\n=======================================================");
	console.log("   Check completed for all accounts! You can run: npm start");
	console.log("=======================================================\n");
}

main().catch((err) => {
	console.error("\nUnexpected error during environment check:", err);
	process.exit(1);
});
