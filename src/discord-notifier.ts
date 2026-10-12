/**
 * Optional Discord webhook notifications (enabled when DISCORD_WEBHOOK_URL is set).
 *
 * - One live "status" card that is edited in place after every retry cycle,
 *   so the channel doesn't fill up with "out of capacity" spam.
 * - Separate cards only for real events: launcher started, VM created,
 *   launch/account errors, all targets provisioned, fatal crash.
 *
 * Every call is fire-and-forget and never throws: a Discord outage must not
 * stop the launcher.
 */

export type AttemptResult = "capacity" | "ratelimit" | "error" | "created";
type TargetStatus = AttemptResult | "pending" | "exists";

interface TargetState {
	status: TargetStatus;
	capacityHits: number;
	at?: Date;
}

interface AccountState {
	region: string;
	targets: Map<string, TargetState>;
}

export interface StartSummary {
	targets: string[];
	shape: string;
	ocpus: number;
	memoryInGBs: number;
	bootVolumeSize: number;
	bootVolumeVpu: number;
	retryInterval: number;
	accounts: { label: string; region: string; pending: string[]; existing: string[] }[];
}

export interface CreatedDetails {
	instanceName: string;
	accountLabel: string;
	region: string;
	instanceId: string;
	lifecycleState?: string;
	faultDomain?: string;
	publicIp?: string;
	privateIp?: string;
}

interface Embed {
	title?: string;
	description?: string;
	color?: number;
	fields?: { name: string; value: string; inline?: boolean }[];
	footer?: { text: string };
	timestamp?: string;
}

const COLOR = {
	hunting: 0xf5a623,
	success: 0x2ecc71,
	done: 0xf1c40f,
	info: 0x5865f2,
	warn: 0xe67e22,
	error: 0xed4245,
};

const FLAGS: Record<string, string> = {
	"ap-singapore-1": "🇸🇬",
	"ap-sydney-1": "🇦🇺",
	"ap-melbourne-1": "🇦🇺",
	"ap-mumbai-1": "🇮🇳",
	"ap-hyderabad-1": "🇮🇳",
	"ap-tokyo-1": "🇯🇵",
	"ap-osaka-1": "🇯🇵",
	"ap-seoul-1": "🇰🇷",
	"ap-chuncheon-1": "🇰🇷",
	"us-ashburn-1": "🇺🇸",
	"us-phoenix-1": "🇺🇸",
	"us-sanjose-1": "🇺🇸",
	"us-chicago-1": "🇺🇸",
	"ca-toronto-1": "🇨🇦",
	"ca-montreal-1": "🇨🇦",
	"eu-frankfurt-1": "🇩🇪",
	"eu-amsterdam-1": "🇳🇱",
	"uk-london-1": "🇬🇧",
	"eu-paris-1": "🇫🇷",
	"eu-zurich-1": "🇨🇭",
	"eu-stockholm-1": "🇸🇪",
	"eu-milan-1": "🇮🇹",
	"eu-madrid-1": "🇪🇸",
	"me-dubai-1": "🇦🇪",
	"me-jeddah-1": "🇸🇦",
	"sa-saopaulo-1": "🇧🇷",
	"sa-santiago-1": "🇨🇱",
	"af-johannesburg-1": "🇿🇦",
	"il-jerusalem-1": "🇮🇱",
	"mx-queretaro-1": "🇲🇽",
};

const ICON: Record<TargetStatus, string> = {
	pending: "⏳",
	capacity: "🔴",
	ratelimit: "🟠",
	error: "❌",
	created: "✅",
	exists: "✅",
};

const LABEL: Record<TargetStatus, string> = {
	pending: "waiting",
	capacity: "out of capacity",
	ratelimit: "rate limited",
	error: "error",
	created: "created",
	exists: "already exists",
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const unix = (d: Date) => Math.floor(d.getTime() / 1000);
const flag = (region: string) => FLAGS[region] ?? "🌐";
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const shortLabel = (label: string) => label.replace(/\s*\(.*\)\s*$/, "");

export class DiscordNotifier {
	private readonly url?: string;
	private queue: Promise<unknown> = Promise.resolve();
	private statusMessageId?: string;
	private statusQueued = false;

	private readonly accounts = new Map<string, AccountState>();
	private readonly startedAt = new Date();
	private footer = "";
	private cycle = 0;
	private attempts = 0;
	private capacityHits = 0;
	private nextAttemptAt?: Date;
	private finished = false;

	constructor(webhookUrl = process.env.DISCORD_WEBHOOK_URL?.trim()) {
		this.url = webhookUrl || undefined;
	}

	get enabled(): boolean {
		return Boolean(this.url);
	}

	started(summary: StartSummary) {
		for (const acc of summary.accounts) {
			const targets = new Map<string, TargetState>();
			for (const name of summary.targets) {
				targets.set(name, {
					status: acc.existing.includes(name) ? "exists" : "pending",
					capacityHits: 0,
				});
			}
			this.accounts.set(acc.label, { region: acc.region, targets });
		}
		this.footer = [
			`${summary.shape} (${summary.ocpus} OCPU, ${summary.memoryInGBs} GB RAM)`,
			`${summary.bootVolumeSize} GB boot`,
			`retry ${summary.retryInterval}s`,
		].join("  •  ");

		const accountLines = summary.accounts.map(
			(a) =>
				`${flag(a.region)} **${shortLabel(a.label)}** · ${a.region} — pending: ${a.pending.join(", ") || "none"}`,
		);
		this.post({
			title: "🚀 Launcher started",
			color: COLOR.info,
			fields: [
				{ name: "Targets", value: summary.targets.join(", ") || "—", inline: true },
				{ name: "Shape", value: `${summary.shape}\n${summary.ocpus} OCPU · ${summary.memoryInGBs} GB`, inline: true },
				{ name: "Boot volume", value: `${summary.bootVolumeSize} GB (VPU ${summary.bootVolumeVpu})`, inline: true },
				{ name: "Accounts", value: clip(accountLines.join("\n") || "—", 1024) },
			],
			timestamp: new Date().toISOString(),
		});
	}

	attempt(accountLabel: string, targetName: string, result: AttemptResult, detail?: string) {
		const target = this.target(accountLabel, targetName);
		target.status = result;
		target.at = new Date();
		this.attempts++;
		if (result === "capacity") {
			target.capacityHits++;
			this.capacityHits++;
		}
		if (result === "error" && detail) {
			this.post({
				title: `❌ Launch failed — ${targetName}`,
				description: `${flag(this.region(accountLabel))} **${accountLabel}**\n\`\`\`\n${clip(detail, 3800)}\n\`\`\``,
				color: COLOR.error,
				timestamp: new Date().toISOString(),
			});
		}
	}

	cycleCompleted(cycle: number, waitSeconds: number) {
		this.cycle = cycle;
		this.nextAttemptAt = new Date(Date.now() + waitSeconds * 1000);
		this.pushStatus();
	}

	created(d: CreatedDetails) {
		const fields: Embed["fields"] = [
			{ name: "Account", value: `${flag(d.region)} ${d.accountLabel}`, inline: true },
			{ name: "Region", value: d.region, inline: true },
			{ name: "State", value: d.lifecycleState || "—", inline: true },
			{ name: "Public IP", value: d.publicIp ? `\`${d.publicIp}\`` : "pending", inline: true },
			{ name: "Private IP", value: d.privateIp ? `\`${d.privateIp}\`` : "—", inline: true },
			{ name: "Fault domain", value: d.faultDomain || "—", inline: true },
		];
		if (d.publicIp) {
			fields.push({ name: "Connect", value: `\`\`\`bash\nssh ubuntu@${d.publicIp}\n\`\`\`` });
		}
		fields.push({ name: "OCID", value: `\`${d.instanceId}\`` });
		this.post({
			title: `✅ VM created — ${d.instanceName}`,
			color: COLOR.success,
			fields,
			timestamp: new Date().toISOString(),
		});
		this.pushStatus();
	}

	accountDisabled(accountLabel: string, reason: string) {
		this.post({
			title: `⛔ Account disabled — ${shortLabel(accountLabel)}`,
			description: `OCI rejected the credentials or parameters, so this account stopped retrying.\n\`\`\`\n${clip(reason, 3600)}\n\`\`\``,
			color: COLOR.error,
			timestamp: new Date().toISOString(),
		});
	}

	warn(title: string, message: string) {
		this.post({
			title: `⚠️ ${title}`,
			description: `\`\`\`\n${clip(message, 3900)}\n\`\`\``,
			color: COLOR.warn,
			timestamp: new Date().toISOString(),
		});
	}

	allProvisioned(records: { account: string; name: string; publicIp?: string }[]) {
		this.finished = true;
		this.pushStatus();
		const lines = records.map(
			(r) => `✅ \`${r.name}\` · ${shortLabel(r.account)} · ${r.publicIp ? `\`${r.publicIp}\`` : "IP pending"}`,
		);
		this.post({
			title: "🏁 All target instances provisioned",
			description: clip(lines.join("\n") || "Nothing left to launch.", 4000),
			color: COLOR.done,
			timestamp: new Date().toISOString(),
		});
	}

	fatal(err: unknown) {
		const msg = err instanceof Error ? err.stack || err.message : String(err);
		this.post({
			title: "💥 Launcher crashed",
			description: `\`\`\`\n${clip(msg, 3900)}\n\`\`\``,
			color: COLOR.error,
			timestamp: new Date().toISOString(),
		});
	}

	/** Wait until all queued Discord requests are sent (call before process.exit). */
	async flush(timeoutMs = 10000) {
		await Promise.race([this.queue, sleep(timeoutMs)]);
	}

	private region(accountLabel: string) {
		return this.accounts.get(accountLabel)?.region ?? accountLabel.match(/\(([a-z0-9-]+)\)/)?.[1] ?? "";
	}

	private target(accountLabel: string, targetName: string): TargetState {
		let acc = this.accounts.get(accountLabel);
		if (!acc) {
			acc = { region: this.region(accountLabel), targets: new Map() };
			this.accounts.set(accountLabel, acc);
		}
		let t = acc.targets.get(targetName);
		if (!t) {
			t = { status: "pending", capacityHits: 0 };
			acc.targets.set(targetName, t);
		}
		return t;
	}

	private statusEmbed(): Embed {
		const all = [...this.accounts.values()].flatMap((a) => [...a.targets.values()]);
		const done = all.filter((t) => t.status === "created" || t.status === "exists").length;

		const lines = [
			this.finished ? "🎉 **All target instances provisioned.**" : "Hunting for free capacity…",
			"",
			`🔁 Cycle **#${this.cycle}** · ${this.attempts} launch attempts · ${this.capacityHits} × out of capacity`,
			`📦 Instances **${done}/${all.length}** created`,
			`🕒 Running since <t:${unix(this.startedAt)}:R>`,
		];
		if (!this.finished && this.nextAttemptAt) {
			lines.push(`⏭️ Next attempt <t:${unix(this.nextAttemptAt)}:R>`);
		}

		const fields = [...this.accounts.entries()].map(([label, acc]) => ({
			name: `${flag(acc.region)}  ${shortLabel(label)} · ${acc.region}`,
			value: clip(
				[...acc.targets.entries()]
					.map(([name, t]) => {
						const hits = t.status === "capacity" ? ` ×${t.capacityHits}` : "";
						const when = t.at ? ` · <t:${unix(t.at)}:R>` : "";
						return `${ICON[t.status]} \`${name}\` ${LABEL[t.status]}${hits}${when}`;
					})
					.join("\n") || "—",
				1024,
			),
		}));

		return {
			title: this.finished ? "🏁 OCI ARM Launcher — complete" : "🛰️ OCI ARM Launcher — live status",
			description: lines.join("\n"),
			color: this.finished ? COLOR.done : COLOR.hunting,
			fields,
			footer: this.footer ? { text: this.footer } : undefined,
			timestamp: new Date().toISOString(),
		};
	}

	private pushStatus() {
		// The embed is built when the queued task runs, so one pending update is always enough
		if (!this.url || this.statusQueued) return;
		this.statusQueued = true;
		this.enqueue(async () => {
			this.statusQueued = false;
			const embeds = [this.statusEmbed()];
			if (this.statusMessageId) {
				const res = await this.request("PATCH", `/messages/${this.statusMessageId}`, { embeds });
				if (res !== "gone") return;
				this.statusMessageId = undefined; // card was deleted in Discord: post a new one
			}
			const msg = await this.request("POST", "?wait=true", { embeds });
			if (msg && typeof msg === "object" && "id" in msg) this.statusMessageId = String(msg.id);
		});
	}

	private post(embed: Embed) {
		if (!this.url) return;
		this.enqueue(() => this.request("POST", "", { embeds: [embed] }));
	}

	private enqueue(task: () => Promise<unknown>) {
		this.queue = this.queue.then(task).catch(() => {});
	}

	private async request(method: "POST" | "PATCH", path: string, body: object): Promise<unknown> {
		for (let attempt = 0; attempt < 5; attempt++) {
			try {
				const res = await fetch(`${this.url}${path}`, {
					method,
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ allowed_mentions: { parse: [] }, ...body }),
				});
				if (res.ok) return res.status === 204 ? null : await res.json();
				if (res.status === 429) {
					const data = (await res.json().catch(() => ({}))) as { retry_after?: number };
					await sleep((data.retry_after ?? 2) * 1000 + 250);
					continue;
				}
				if (res.status === 404 && method === "PATCH") return "gone";
				console.error(`[DISCORD] Webhook ${method} failed (${res.status}): ${clip(await res.text(), 200)}`);
				return null;
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err);
				console.error(`[DISCORD] Webhook request error: ${msg}`);
				await sleep(2000);
			}
		}
		return null;
	}
}
