import * as core from "oci-core";
import type { LaunchConfig } from "./types.js";

interface LaunchDetailsParams {
	targetName: string;
	faultDomain?: string;
	compartmentId: string;
	availabilityDomain: string;
	imageId: string;
	subnetId: string;
	sshKey: string;
	config: LaunchConfig;
}

export function createLaunchDetails(
	params: LaunchDetailsParams,
): core.requests.LaunchInstanceRequest {
	const {
		targetName,
		faultDomain,
		compartmentId,
		availabilityDomain,
		imageId,
		subnetId,
		sshKey,
		config,
	} = params;

	return {
		launchInstanceDetails: {
			compartmentId,
			displayName: targetName,
			availabilityDomain,
			...(faultDomain ? { faultDomain } : {}),
			shape: config.shape,
			shapeConfig: {
				ocpus: config.ocpus,
				memoryInGBs: config.memoryInGBs,
			},
			sourceDetails: {
				sourceType: "image",
				imageId,
				bootVolumeSizeInGBs: config.bootVolumeSize,
				bootVolumeVpusPerGB: config.bootVolumeVpu,
			},
			isPvEncryptionInTransitEnabled: true,
			createVnicDetails: {
				assignPublicIp: config.assignPublicIp,
				subnetId,
				displayName: `VNIC-${targetName}`,
			},
			metadata: {
				ssh_authorized_keys: sshKey,
			},
			agentConfig: {
				isMonitoringDisabled: false,
				isManagementDisabled: true,
				pluginsConfig: [
					{
						name: "Custom Logs Monitoring",
						desiredState:
							core.models.InstanceAgentPluginConfigDetails.DesiredState.Enabled,
					},
					{
						name: "Compute Instance Run Command",
						desiredState:
							core.models.InstanceAgentPluginConfigDetails.DesiredState.Enabled,
					},
					{
						name: "Compute Instance Monitoring",
						desiredState:
							core.models.InstanceAgentPluginConfigDetails.DesiredState.Enabled,
					},
					{
						name: "Cloud Guard Workload Protection",
						desiredState:
							core.models.InstanceAgentPluginConfigDetails.DesiredState.Enabled,
					},
				],
			},
		},
	};
}
