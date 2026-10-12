import nodemailer from "nodemailer";

export interface ServerEmailDetails {
	instanceName: string;
	accountLabel: string;
	region: string;
	instanceId: string;
	lifecycleState?: string;
	shape: string;
	ocpus: number;
	memoryInGBs: number;
	bootVolumeSize: number;
	faultDomain?: string;
	availabilityDomain?: string;
	publicIp?: string;
	privateIp?: string;
	timeCreated?: string;
}

const getSenderEmail = (): string => {
	const sender = process.env.SENDER_EMAIL?.trim();
	if (!sender) {
		throw new Error("Missing SENDER_EMAIL environment variable.");
	}
	return sender;
};

/** Recipient(s) for notifications (comma-separated allowed), or undefined when none is configured. */
export const resolveRecipientEmail = (override?: string): string | undefined =>
	override?.trim() ||
	process.env.RECIPIENT_EMAIL?.trim() ||
	process.env.NOTIFICATION_EMAIL?.trim() ||
	process.env.SENDER_EMAIL?.trim() ||
	undefined;

const getRecipientEmail = (override?: string): string => {
	const recipient = resolveRecipientEmail(override);

	if (!recipient) {
		throw new Error(
			"No recipient email configured. Set RECIPIENT_EMAIL or SENDER_EMAIL in .env.",
		);
	}
	return recipient;
};

/** True when SMTP credentials and a recipient are configured. */
export const isEmailConfigured = (): boolean =>
	Boolean(process.env.SENDER_EMAIL?.trim() && process.env.SENDER_APP_PASS?.trim() && resolveRecipientEmail());

const createTransporter = () => {
	const user = getSenderEmail();
	const pass = process.env.SENDER_APP_PASS?.trim();

	if (!pass) {
		throw new Error("Missing SENDER_APP_PASS environment variable.");
	}

	return nodemailer.createTransport({
		host: "smtp.gmail.com",
		port: 587,
		secure: false,
		auth: { user, pass },
		tls: {
			rejectUnauthorized: false,
		},
	});
};

export const sendEmail = async (to: string, subject: string, html: string) => {
	const senderEmail = getSenderEmail();
	const transporter = createTransporter();

	return transporter.sendMail({
		from: `"Oracle VM Launcher" <${senderEmail}>`,
		to,
		subject,
		html,
	});
};

export const sendServerCreatedEmail = async (
	details: ServerEmailDetails,
	targetRecipient?: string,
) => {
	const recipientEmail = getRecipientEmail(targetRecipient);
	const subject = `[Oracle Cloud] VM Created: ${details.instanceName} (${details.accountLabel})`;
	const publicIpText = details.publicIp || "Pending / Not assigned";
	const sshCmd = details.publicIp ? `ssh ubuntu@${details.publicIp}` : "N/A";
	const createdTime = details.timeCreated || new Date().toISOString();

	const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background-color: #f4f5f7; margin: 0; padding: 24px; color: #172b4d; }
    .container { max-width: 640px; margin: 0 auto; background: #ffffff; border-radius: 8px; border: 1px solid #dfe1e6; overflow: hidden; box-shadow: 0 4px 12px rgba(0,0,0,0.05); }
    .header { background: #0f172a; color: #ffffff; padding: 24px; text-align: left; }
    .header h1 { margin: 0; font-size: 20px; font-weight: 600; }
    .header p { margin: 6px 0 0; font-size: 13px; color: #94a3b8; }
    .content { padding: 24px; }
    .badge { display: inline-block; padding: 4px 10px; background-color: #dcfce7; color: #15803d; font-size: 12px; font-weight: 600; border-radius: 4px; margin-bottom: 16px; }
    .card { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px; padding: 16px; margin-bottom: 20px; }
    .row { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #f1f5f9; font-size: 14px; }
    .row:last-child { border-bottom: none; }
    .label { color: #64748b; font-weight: 500; }
    .value { color: #0f172a; font-weight: 600; text-align: right; word-break: break-all; }
    .code-block { background: #0f172a; color: #38bdf8; padding: 12px 16px; border-radius: 6px; font-family: "SFMono-Regular", Consolas, Menlo, monospace; font-size: 13px; margin-top: 12px; word-break: break-all; }
    .footer { padding: 16px 24px; background: #f8fafc; border-top: 1px solid #e2e8f0; font-size: 12px; color: #94a3b8; text-align: center; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>Oracle Cloud ARM Instance Provisioned</h1>
      <p>Automated deployment completed successfully.</p>
    </div>
    <div class="content">
      <span class="badge">PROVISIONED & ACTIVE</span>
      <div class="card">
        <div class="row"><span class="label">Instance Name</span><span class="value">${details.instanceName}</span></div>
        <div class="row"><span class="label">Account</span><span class="value">${details.accountLabel}</span></div>
        <div class="row"><span class="label">Region</span><span class="value">${details.region}</span></div>
        <div class="row"><span class="label">Availability Domain</span><span class="value">${details.availabilityDomain || "Default"}</span></div>
        <div class="row"><span class="label">Fault Domain</span><span class="value">${details.faultDomain || "Auto"}</span></div>
        <div class="row"><span class="label">Public IP</span><span class="value">${publicIpText}</span></div>
        <div class="row"><span class="label">Private IP</span><span class="value">${details.privateIp || "N/A"}</span></div>
        <div class="row"><span class="label">Shape</span><span class="value">${details.shape}</span></div>
        <div class="row"><span class="label">Specs</span><span class="value">${details.ocpus} OCPU / ${details.memoryInGBs} GB RAM / ${details.bootVolumeSize} GB Disk</span></div>
        <div class="row"><span class="label">OCID</span><span class="value">${details.instanceId}</span></div>
        <div class="row"><span class="label">Created At</span><span class="value">${createdTime}</span></div>
      </div>
      <div>
        <span class="label">Quick SSH Command:</span>
        <div class="code-block">${sshCmd}</div>
      </div>
    </div>
    <div class="footer">
      Sent by Oracle VM Launcher
    </div>
  </div>
</body>
</html>
  `.trim();

	return sendEmail(recipientEmail, subject, html);
};
