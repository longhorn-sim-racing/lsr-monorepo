/**
 * Base email template wrapper with LSR branding.
 * All notification emails use this layout.
 *
 * Uses table-based layout and inline styles for maximum email client compatibility.
 */

export type BaseTemplateProps = {
  previewText?: string;
  title: string;
  body: string; // HTML content
  actionUrl?: string;
  actionText?: string;
  footerText?: string;
  /** Leave out the "Manage email preferences" link (for mail that ignores those preferences) */
  hidePreferencesLink?: boolean;
};

export function baseTemplate({
  previewText,
  title,
  body,
  actionUrl,
  actionText,
  footerText,
  hidePreferencesLink = false,
}: BaseTemplateProps): { html: string; text: string } {
  const currentYear = new Date().getFullYear();

  // Colors - using solid colors that work in both light and dark modes
  const colors = {
    bgOuter: "#1a1a1a",
    bgContent: "#262626",
    textPrimary: "#ffffff",
    textSecondary: "#b3b3b3",
    textMuted: "#808080",
    accent: "#ff6b00",
    border: "#404040",
  };

  const html = `
<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <meta name="x-apple-disable-message-reformatting">
  <meta name="color-scheme" content="dark light">
  <meta name="supported-color-schemes" content="dark light">
  <title>${title}</title>
  ${previewText ? `<span style="display:none;font-size:1px;color:#1a1a1a;max-height:0;max-width:0;opacity:0;overflow:hidden;">${previewText}</span>` : ""}
  <!--[if mso]>
  <style type="text/css">
    table, td {border-collapse: collapse;}
    .button-link {padding: 16px 32px !important;}
  </style>
  <![endif]-->
  <style>
    :root { color-scheme: dark light; supported-color-schemes: dark light; }
    @media (prefers-color-scheme: dark) {
      .email-bg { background-color: ${colors.bgOuter} !important; }
    }
  </style>
</head>
<body style="margin:0;padding:0;word-spacing:normal;background-color:${colors.bgOuter};">
  <div role="article" aria-roledescription="email" lang="en" style="text-size-adjust:100%;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;background-color:${colors.bgOuter};">

    <!-- Outer table for background color -->
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background-color:${colors.bgOuter};" class="email-bg">
      <tr>
        <td align="center" style="padding:40px 20px;">

          <!-- Main content container -->
          <table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0" style="max-width:600px;width:100%;">

            <!-- Header with logo -->
            <tr>
              <td align="center" style="padding-bottom:32px;">
                <img
                  src="https://www.longhornsimracing.org/brand/logos/white_logo2.png"
                  alt="Longhorn Sim Racing"
                  width="60"
                  style="display:block;width:60px;height:auto;border:0;"
                />
                <p style="margin:12px 0 0 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;font-size:16px;font-weight:800;font-style:italic;text-transform:uppercase;letter-spacing:0.02em;color:${colors.textPrimary};">
                  Longhorn Sim Racing
                </p>
              </td>
            </tr>

            <!-- Content box -->
            <tr>
              <td style="background-color:${colors.bgContent};border:1px solid ${colors.border};padding:32px;">

                <!-- Title -->
                <h1 style="margin:0 0 20px 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;font-size:24px;font-weight:800;font-style:italic;text-transform:uppercase;color:${colors.textPrimary};line-height:1.2;">
                  ${title}
                </h1>

                <!-- Body content -->
                <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;font-size:16px;line-height:1.6;color:${colors.textSecondary};">
                  ${body}
                </div>

                <!-- CTA Button -->
                ${actionUrl && actionText ? `
                <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin-top:28px;">
                  <tr>
                    <td style="background-color:${colors.accent};border-radius:0;">
                      <a href="${actionUrl}" target="_blank" style="display:inline-block;padding:16px 32px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.15em;color:#ffffff;text-decoration:none;" class="button-link">
                        ${actionText}
                      </a>
                    </td>
                  </tr>
                </table>
                ` : ""}

              </td>
            </tr>

            <!-- Footer -->
            <tr>
              <td style="padding-top:32px;border-top:none;">
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                  ${footerText ? `
                  <tr>
                    <td align="center" style="padding-bottom:8px;">
                      <p style="margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;font-size:12px;color:${colors.textMuted};">
                        ${footerText}
                      </p>
                    </td>
                  </tr>
                  ` : ""}
                  <tr>
                    <td align="center" style="padding-bottom:8px;">
                      <p style="margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;font-size:12px;color:${colors.textMuted};">
                        &copy; ${currentYear} Longhorn Sim Racing &bull; University of Texas at Austin
                      </p>
                    </td>
                  </tr>
                  ${hidePreferencesLink ? "" : `<tr>
                    <td align="center">
                      <a href="https://www.longhornsimracing.org/account" style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;font-size:12px;color:${colors.accent};text-decoration:none;">
                        Manage email preferences
                      </a>
                    </td>
                  </tr>`}
                </table>
              </td>
            </tr>

          </table>
        </td>
      </tr>
    </table>

  </div>
</body>
</html>
  `.trim();

  // Generate plain text version
  const text = `
${title.toUpperCase()}

${body.replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim()}

${actionUrl && actionText ? `${actionText}: ${actionUrl}` : ""}

---
${footerText ? footerText + "\n" : ""}
Longhorn Sim Racing | University of Texas at Austin
Manage preferences: https://www.longhornsimracing.org/account
  `.trim();

  return { html, text };
}
