import type * as common from "oci-common";

export interface AuthProviderResult {
	provider: common.AuthenticationDetailsProvider;
	compartmentId: string;
	region: string;
}

export interface AccountConfig {
	id: string;
	label: string;
	envSuffix: string;
	tenancyId: string;
	userId: string;
	fingerprint: string;
	region: string;
	keyPath: string;
	sshKey: string;
	compartmentId: string;
}

export interface InstanceRecord {
	account: string;
	name: string;
	id?: string;
	lifecycleState?: string;
	publicIp?: string;
	privateIp?: string;
	region?: string;
	createdAt?: string;
}

export interface LaunchConfig {
	shape: string;
	ocpus: number;
	memoryInGBs: number;
	bootVolumeSize: number;
	bootVolumeVpu: number;
	configuredFaultDomain?: string;
	assignPublicIp: boolean;
	retryInterval: number;
	targetInstanceNames: string[];
}
