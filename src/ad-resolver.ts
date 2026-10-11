import type * as identity from "oci-identity";

export async function resolveAvailabilityDomain(
	identityClient: identity.IdentityClient,
	compartmentId: string,
	envSuffix = "",
): Promise<string> {
	const overrideAd =
		process.env[`OCI_AVAILABILITY_DOMAIN${envSuffix}`]?.trim() ||
		(envSuffix === "" ? process.env.OCI_AVAILABILITY_DOMAIN?.trim() : undefined);

	if (overrideAd) {
		return overrideAd;
	}

	const adResp = await identityClient.listAvailabilityDomains({
		compartmentId,
	});
	const ads = adResp.items || [];
	if (ads.length === 0) {
		throw new Error("No Availability Domains found for compartment.");
	}

	const ad1 = ads.find((a) => a?.name?.includes("AD-1"));
	const selected = ad1 ? ad1.name : ads[0].name;
	console.log(`[AD${envSuffix ? `-${envSuffix}` : ""}] Selected Availability Domain: "${selected}"`);
	return selected as string;
}
