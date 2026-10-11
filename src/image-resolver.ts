import type * as core from "oci-core";

export async function resolveImageId(
	computeClient: core.ComputeClient,
	compartmentId: string,
	envSuffix = "",
): Promise<string> {
	const overrideImageId =
		process.env[`OCI_IMAGE_OCID${envSuffix}`]?.trim() ||
		(envSuffix === "" ? process.env.OCI_IMAGE_OCID?.trim() : undefined);

	if (overrideImageId) {
		return overrideImageId;
	}

	console.log(
		`[IMAGE${envSuffix ? `-${envSuffix}` : ""}] Resolving latest Canonical Ubuntu 24.04 ARM (aarch64) image...`,
	);
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
		console.log(
			`[IMAGE${envSuffix ? `-${envSuffix}` : ""}] Selected: "${minimal2404.displayName}" (${minimal2404.id})`,
		);
		return minimal2404.id;
	}

	const standard2404 = images.find(
		(img) =>
			img.displayName?.includes("24.04") &&
			img.displayName?.includes("aarch64"),
	);

	if (standard2404) {
		console.log(
			`[IMAGE${envSuffix ? `-${envSuffix}` : ""}] Selected: "${standard2404.displayName}" (${standard2404.id})`,
		);
		return standard2404.id;
	}

	if (images.length > 0) {
		console.log(
			`[IMAGE${envSuffix ? `-${envSuffix}` : ""}] Using first available Ubuntu ARM image: "${images[0].displayName}" (${images[0].id})`,
		);
		return images[0].id;
	}

	throw new Error(
		"Could not find an Ubuntu ARM image for shape VM.Standard.A1.Flex in this region.",
	);
}
