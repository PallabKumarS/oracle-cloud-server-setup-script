import * as fs from "node:fs";
import * as path from "node:path";
import * as common from "oci-common";
import type { AccountConfig, AuthProviderResult } from "./types.js";

export function getAuthProvider(envSuffix = ""): AuthProviderResult {
	const tenancyId = process.env[`OCI_TENANCY_OCID${envSuffix}`]?.trim();
	const userId = process.env[`OCI_USER_OCID${envSuffix}`]?.trim();
	const fingerprint = process.env[`OCI_FINGERPRINT${envSuffix}`]?.trim();
	const defaultRegion = envSuffix === "2" ? "ap-sydney-1" : "ap-singapore-1";
	const regionStr = process.env[`OCI_REGION${envSuffix}`]?.trim() || defaultRegion;
	const defaultKeyPath = envSuffix === "2" ? "./oci_private_key2.pem" : "./oci_private_key.pem";
	const keyPath = process.env[`OCI_PRIVATE_KEY_PATH${envSuffix}`]?.trim() || defaultKeyPath;

	if (!tenancyId || !userId || !fingerprint || !keyPath) {
		console.error(`Missing required environment variables for Account${envSuffix || " 1"}:`);
		if (!tenancyId) console.error(`  - OCI_TENANCY_OCID${envSuffix}`);
		if (!userId) console.error(`  - OCI_USER_OCID${envSuffix}`);
		if (!fingerprint) console.error(`  - OCI_FINGERPRINT${envSuffix}`);
		if (!keyPath) console.error(`  - OCI_PRIVATE_KEY_PATH${envSuffix}`);
		process.exit(1);
	}

	const resolvedKeyPath = path.isAbsolute(keyPath)
		? keyPath
		: path.resolve(process.cwd(), keyPath);

	if (!fs.existsSync(resolvedKeyPath)) {
		console.error(`Private key file not found at: ${resolvedKeyPath}`);
		process.exit(1);
	}

	const privateKey = fs.readFileSync(resolvedKeyPath, "utf8");
	const region = common.Region.fromRegionId(regionStr);
	const compartmentId =
		process.env[`OCI_COMPARTMENT_OCID${envSuffix}`]?.trim() || tenancyId;

	const passphrase = process.env[`OCI_PASSPHRASE${envSuffix}`] || null;

	const provider = new common.SimpleAuthenticationDetailsProvider(
		tenancyId,
		userId,
		fingerprint,
		privateKey,
		passphrase,
		region,
	);

	return { provider, compartmentId, region: regionStr };
}

export function getSshKey(envSuffix = ""): string {
	let key = process.env[`OCI_SSH_PUBLIC_KEY${envSuffix}`]?.trim() || "";
	const keyPathVar = process.env[`OCI_SSH_PUBLIC_KEY_PATH${envSuffix}`]?.trim();

	if (!key && keyPathVar) {
		const resolved = path.isAbsolute(keyPathVar)
			? keyPathVar
			: path.resolve(process.cwd(), keyPathVar);
		if (fs.existsSync(resolved)) {
			key = fs.readFileSync(resolved, "utf8").trim();
		}
	}

	if (!key && envSuffix !== "") {
		key = process.env.OCI_SSH_PUBLIC_KEY?.trim() || "";
	}

	if (!key) {
		console.error(
			`No SSH Public Key provided in OCI_SSH_PUBLIC_KEY${envSuffix} or OCI_SSH_PUBLIC_KEY_PATH${envSuffix}.`,
		);
		console.error("Please add your SSH public key so you can access your VM.");
		process.exit(1);
	}
	return key;
}

export function getActiveAccountConfigs(): AccountConfig[] {
	const suffixes = ["", "2"];
	const accounts: AccountConfig[] = [];

	for (const suffix of suffixes) {
		const userId = process.env[`OCI_USER_OCID${suffix}`]?.trim();
		const tenancyId = process.env[`OCI_TENANCY_OCID${suffix}`]?.trim();
		if (!userId || !tenancyId) {
			continue;
		}

		const defaultRegion = suffix === "2" ? "ap-sydney-1" : "ap-singapore-1";
		const region = process.env[`OCI_REGION${suffix}`]?.trim() || defaultRegion;
		const defaultKeyPath = suffix === "2" ? "./oci_private_key2.pem" : "./oci_private_key.pem";
		const keyPath = process.env[`OCI_PRIVATE_KEY_PATH${suffix}`]?.trim() || defaultKeyPath;
		const fingerprint = process.env[`OCI_FINGERPRINT${suffix}`]?.trim() || "";
		const compartmentId = process.env[`OCI_COMPARTMENT_OCID${suffix}`]?.trim() || tenancyId;
		const sshKey = getSshKey(suffix);
		const id = suffix ? `account${suffix}` : "account1";
		const label = suffix ? `Account ${suffix} (${region})` : `Account 1 (${region})`;

		accounts.push({
			id,
			label,
			envSuffix: suffix,
			tenancyId,
			userId,
			fingerprint,
			region,
			keyPath,
			sshKey,
			compartmentId,
		});
	}

	return accounts;
}
