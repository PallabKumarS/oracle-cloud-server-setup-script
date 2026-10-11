import type * as core from "oci-core";

export async function fetchVnicIps(
	computeClient: core.ComputeClient,
	networkClient: core.VirtualNetworkClient,
	compartmentId: string,
	instanceId: string,
): Promise<{ publicIp?: string; privateIp?: string }> {
	try {
		const vnicAttachments = await computeClient.listVnicAttachments({
			compartmentId,
			instanceId,
		});
		const vnicId = vnicAttachments.items?.[0]?.vnicId;
		if (vnicId) {
			const vnic = await networkClient.getVnic({ vnicId });
			return {
				publicIp: vnic.vnic.publicIp,
				privateIp: vnic.vnic.privateIp,
			};
		}
	} catch {
		// Ignore VNIC query errors if instance is still booting
	}
	return {};
}
