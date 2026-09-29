import Link from "next/link"
import { Metadata } from "next"

export const metadata: Metadata = {
  title: "Privacy Policy",
  description:
    "How Longhorn Sim Racing collects, uses, and protects your personal information.",
  alternates: {
    canonical: "/privacy",
  },
}

const LAST_UPDATED = "May 16, 2026"
const EFFECTIVE_DATE = "May 16, 2026"
const CONTACT_EMAIL = "info@longhornsimracing.org"

type SectionProps = { id: string; title: string; children: React.ReactNode }
function Section({ id, title, children }: SectionProps) {
  return (
    <section id={id} className="space-y-4 scroll-mt-24">
      <h2 className="font-display font-black italic text-2xl md:text-3xl text-white uppercase tracking-normal border-b border-white/10 pb-3">
        {title}
      </h2>
      <div className="space-y-4 text-white/70 leading-relaxed text-[15px]">{children}</div>
    </section>
  )
}

type SubSectionProps = { id?: string; title: string; children: React.ReactNode }
function SubSection({ id, title, children }: SubSectionProps) {
  return (
    <div id={id} className={id ? "scroll-mt-24 space-y-3" : "space-y-3"}>
      <h3 className="font-sans font-bold text-base md:text-lg text-white uppercase tracking-tight">
        {title}
      </h3>
      <div className="space-y-3 text-white/70 leading-relaxed">{children}</div>
    </div>
  )
}

function P({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <p className={`text-white/70 leading-relaxed${className ? ` ${className}` : ""}`}>
      {children}
    </p>
  )
}

function UL({ children }: { children: React.ReactNode }) {
  return (
    <ul className="space-y-2 text-white/70 ml-5 list-disc marker:text-lsr-orange">
      {children}
    </ul>
  )
}

const toc: { id: string; label: string }[] = [
  { id: "intro", label: "1. Introduction" },
  { id: "info-we-collect", label: "2. Information We Collect" },
  { id: "how-we-use", label: "3. How We Use Information" },
  { id: "how-we-share", label: "4. How We Share Information" },
  { id: "cookies", label: "5. Cookies and Similar Technologies" },
  { id: "public-info", label: "6. Publicly Visible Information" },
  { id: "children", label: "7. Children's Privacy" },
  { id: "your-rights", label: "8. Your Rights and Choices" },
  { id: "state-rights", label: "9. U.S. State Privacy Rights" },
  { id: "retention", label: "10. Data Retention" },
  { id: "security", label: "11. Data Security" },
  { id: "international", label: "12. International Users" },
  { id: "third-party-links", label: "13. Third-Party Links" },
  { id: "changes", label: "14. Changes to This Policy" },
  { id: "contact", label: "15. Contact Us" },
]

export default function PrivacyPage() {
  return (
    <main className="bg-lsr-charcoal text-white min-h-screen">
      <div className="mx-auto max-w-4xl px-6 md:px-8 py-20 md:py-28">
        <h1 className="font-display font-black italic text-5xl md:text-7xl text-white uppercase tracking-normal leading-[0.9] mb-6">
          Privacy <span className="text-lsr-orange">Policy</span>
        </h1>

        <div className="flex flex-wrap gap-x-8 gap-y-1 text-[11px] font-bold uppercase tracking-[0.2em] text-white/40 mb-12">
          <span>
            Effective: <span className="text-white/70">{EFFECTIVE_DATE}</span>
          </span>
          <span>
            Last Updated: <span className="text-white/70">{LAST_UPDATED}</span>
          </span>
        </div>

        <div className="border border-white/10 bg-white/[0.02] p-6 md:p-8 mb-16">
          <h2 className="font-sans font-black text-[11px] uppercase tracking-[0.25em] text-lsr-orange mb-4">
            Contents
          </h2>
          <nav>
            <ol className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-2 text-sm text-white/70">
              {toc.map((entry) => (
                <li key={entry.id}>
                  <a
                    href={`#${entry.id}`}
                    className="hover:text-lsr-orange transition-colors"
                  >
                    {entry.label}
                  </a>
                </li>
              ))}
            </ol>
          </nav>
        </div>

        <div className="space-y-14">
          <Section id="intro" title="1. Introduction">
            <P>
              Longhorn Sim Racing (&ldquo;LSR,&rdquo; &ldquo;we,&rdquo; &ldquo;us,&rdquo; or &ldquo;our&rdquo;) is a Texas
              nonprofit corporation recognized as a 501(c)(3) tax-exempt organization and a
              student organization affiliated with The University of Texas at Austin. We operate
              the website at{" "}
              <a
                href="https://www.longhornsimracing.org"
                className="text-lsr-orange hover:underline font-medium"
              >
                www.longhornsimracing.org
              </a>{" "}
              and provide a platform for sim racing events, race results, membership
              management, and related content (collectively, the &ldquo;Service&rdquo;).
            </P>
            <P>
              This Privacy Policy explains what information we collect, how we use it, how we
              share it, and the choices you have. It applies to your use of the Service. By
              using the Service, you agree to the practices described here.
            </P>
            <P>
              If you have questions, email{" "}
              <a
                href={`mailto:${CONTACT_EMAIL}`}
                className="text-lsr-orange hover:underline font-medium"
              >
                {CONTACT_EMAIL}
              </a>
              .
            </P>
          </Section>

          <Section id="info-we-collect" title="2. Information We Collect">
            <SubSection title="2.1 Information you provide to us">
              <P>When you create an account or interact with the Service, we collect:</P>
              <P className="font-bold text-white">Account information</P>
              <UL>
                <li>Your name and email address (via Google Sign-In or email/password)</li>
                <li>A unique username (handle) you choose</li>
                <li>Display name and (optionally) a profile photo</li>
                <li>Authentication identifiers from your sign-in provider (e.g., Google)</li>
              </UL>
              <P className="font-bold text-white">Profile information (optional)</P>
              <UL>
                <li>Bio, iRacing rating (iRating), and links to your social media profiles</li>
                <li>Academic major and expected graduation year</li>
                <li>
                  University of Texas Electronic Identification number (UT EID), if you choose to
                  provide it for verification or recordkeeping
                </li>
              </UL>
              <P className="font-bold text-white">Event participation</P>
              <UL>
                <li>Event registrations, waitlist activity, and check-in records</li>
                <li>
                  Race results and telemetry you submit, including lap times, positions, sector
                  times, collisions, and penalties from your sim racing sessions
                </li>
              </UL>
              <P className="font-bold text-white">Communications and content</P>
              <UL>
                <li>Messages you send to us (e.g., to {CONTACT_EMAIL})</li>
                <li>
                  Posts, articles, images, comments, and other content you submit (collectively,
                  &ldquo;User Content&rdquo;)
                </li>
                <li>Notification preferences you set in your account</li>
              </UL>
              <P className="font-bold text-white">Payments</P>
              <UL>
                <li>
                  When you pay for an event registration, our payment processor (Stripe) handles
                  your payment card details directly. We receive only the transaction reference,
                  amount, status, and timestamp &mdash; not your full payment card number.
                </li>
                <li>
                  Sponsorship donations made via Venmo or PayPal are processed by those services;
                  we do not receive your payment card information.
                </li>
              </UL>
            </SubSection>

            <SubSection title="2.2 Information we collect automatically">
              <P>When you access the Service, we and our service providers may collect:</P>
              <UL>
                <li>
                  <span className="font-bold text-white">Usage and performance data</span> &mdash; via
                  Vercel Analytics and Vercel Speed Insights, including aggregated page views,
                  navigation paths, and Core Web Vitals. These tools do not use cross-site
                  advertising cookies.
                </li>
                <li>
                  <span className="font-bold text-white">Session information</span> &mdash; our
                  authentication provider (Supabase) sets HttpOnly cookies to keep you signed in.
                  Your browser&apos;s local storage holds a Shopify cart identifier if you use our
                  store.
                </li>
                <li>
                  <span className="font-bold text-white">Audit and security logs</span> &mdash; for
                  sensitive administrative actions (such as profile edits, registration changes,
                  and payment events) we may record the action, the users involved, your IP
                  address, your user-agent string, a request identifier, and before/after
                  snapshots of changed records.
                </li>
                <li>
                  <span className="font-bold text-white">Device information</span> &mdash; standard
                  HTTP request data such as IP address, browser, operating system, and referring
                  URL, captured by our hosting provider (Vercel).
                </li>
              </UL>
            </SubSection>

            <SubSection title="2.3 Information from third parties">
              <P>
                When you sign in via Google, Google shares your basic profile (name, email,
                profile picture) with us based on the OAuth permissions you grant. We may also
                receive information from third parties you choose to link to (for example, a
                public iRacing profile or social media link you add to your bio).
              </P>
            </SubSection>
          </Section>

          <Section id="how-we-use" title="3. How We Use Information">
            <P>We use the information we collect to:</P>
            <UL>
              <li>Create and manage your account and authenticate you</li>
              <li>Process event registrations, waitlist promotions, and attendance check-in</li>
              <li>Process payments and donations</li>
              <li>
                Send transactional emails such as registration confirmations, waitlist
                promotions, and payment receipts
              </li>
              <li>
                Send event reminders, club news, and other communications, subject to your
                notification preferences (see Section 8)
              </li>
              <li>
                Display your driver profile, race results, and event history on the Service (see
                Section 6)
              </li>
              <li>
                Calculate championship standings, leaderboards, and statistics relating to LSR
                competition
              </li>
              <li>
                Investigate and prevent fraud, abuse, or violations of our Terms of Service
              </li>
              <li>Operate, maintain, and improve the Service</li>
              <li>
                Comply with legal obligations, including tax recordkeeping for donations and
                event payments
              </li>
            </UL>
            <P>
              We do not use your information for behavioral advertising or to build profiles for
              advertising purposes, and we do not sell your personal information.
            </P>
          </Section>

          <Section id="how-we-share" title="4. How We Share Information">
            <P>
              We share information only as described below. We do not sell personal information
              and we do not share personal information for cross-context behavioral advertising.
            </P>

            <SubSection title="4.1 Service providers">
              <P>
                The following providers process information on our behalf to provide the Service.
                Each operates under its own privacy and security commitments.
              </P>
              <div className="overflow-x-auto border border-white/10 bg-white/[0.02] my-4">
                <table className="w-full text-left text-sm">
                  <thead className="bg-white/5 font-sans font-black text-[10px] uppercase tracking-widest text-white/60">
                    <tr>
                      <th className="p-4">Provider</th>
                      <th className="p-4">Purpose</th>
                      <th className="p-4">Data Processed</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/5 font-sans text-white/70 align-top">
                    <tr>
                      <td className="p-4 font-bold text-white">Vercel</td>
                      <td className="p-4">Hosting, analytics, performance monitoring</td>
                      <td className="p-4">All Service data; aggregated usage and performance</td>
                    </tr>
                    <tr>
                      <td className="p-4 font-bold text-white">Supabase</td>
                      <td className="p-4">Authentication and database hosting</td>
                      <td className="p-4">Account credentials, profile data, session tokens</td>
                    </tr>
                    <tr>
                      <td className="p-4 font-bold text-white">Google</td>
                      <td className="p-4">Google Sign-In authentication</td>
                      <td className="p-4">OAuth identity (name, email, profile picture)</td>
                    </tr>
                    <tr>
                      <td className="p-4 font-bold text-white">Stripe</td>
                      <td className="p-4">Payment processing for event fees</td>
                      <td className="p-4">Payment card details, billing information, transaction data</td>
                    </tr>
                    <tr>
                      <td className="p-4 font-bold text-white">Resend</td>
                      <td className="p-4">Transactional and notification email delivery</td>
                      <td className="p-4">Your email address, message content, delivery status</td>
                    </tr>
                    <tr>
                      <td className="p-4 font-bold text-white">Cloudinary</td>
                      <td className="p-4">Image hosting and delivery</td>
                      <td className="p-4">Profile photos, gallery images, event imagery</td>
                    </tr>
                    <tr>
                      <td className="p-4 font-bold text-white">Shopify</td>
                      <td className="p-4">Online merchandise store (merchant of record)</td>
                      <td className="p-4">Cart and order information, payment, shipping address</td>
                    </tr>
                    <tr>
                      <td className="p-4 font-bold text-white">Printful</td>
                      <td className="p-4">Print-on-demand merchandise manufacturing and fulfillment</td>
                      <td className="p-4">Order details, shipping address</td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <P>
                We share only the information each provider needs to perform its function. Most
                of these providers maintain certifications such as SOC 2 or ISO 27001 and process
                data in the United States.
              </P>
            </SubSection>

            <SubSection title="4.2 Public information">
              <P>
                Some information you provide is intentionally public. See Section 6 for what is
                publicly visible.
              </P>
            </SubSection>

            <SubSection title="4.3 Legal disclosures">
              <P>
                We may disclose information when we believe in good faith that disclosure is
                necessary to:
              </P>
              <UL>
                <li>Comply with applicable law, regulation, legal process, or government request</li>
                <li>
                  Enforce our Terms of Service, including investigation of suspected violations
                </li>
                <li>
                  Protect the rights, property, or safety of LSR, our members, or the public
                </li>
                <li>
                  Cooperate with The University of Texas at Austin where required by university
                  policy applicable to recognized student organizations
                </li>
              </UL>
            </SubSection>

            <SubSection title="4.4 Business changes">
              <P>
                If LSR merges with, transfers operations to, or is succeeded by another
                organization (for example, another student organization or nonprofit), your
                information may be transferred as part of that change. We will notify you of any
                material change in ownership of your data and require the successor to honor the
                commitments in this Privacy Policy.
              </P>
            </SubSection>
          </Section>

          <Section id="cookies" title="5. Cookies and Similar Technologies">
            <P>We use only essential cookies and storage required for the Service to operate:</P>
            <UL>
              <li>
                <span className="font-bold text-white">Authentication cookies</span> &mdash; HttpOnly
                cookies set by Supabase keep you signed in.
              </li>
              <li>
                <span className="font-bold text-white">Cart storage</span> &mdash; your browser&apos;s
                local storage holds a Shopify cart identifier so your cart persists across
                visits.
              </li>
              <li>
                <span className="font-bold text-white">Performance measurement</span> &mdash; Vercel
                Analytics and Speed Insights collect aggregated, anonymized performance data
                without cross-site tracking cookies.
              </li>
            </UL>
            <P>
              We do not use advertising, retargeting, or third-party tracking cookies. Because
              we rely on essential storage only, we do not present a cookie-consent banner. You
              can clear cookies and local storage at any time through your browser settings; doing
              so will sign you out.
            </P>
            <P>
              Some browsers offer a &ldquo;Do Not Track&rdquo; signal or Global Privacy Control. We
              do not engage in cross-site tracking or sale of personal information, so these
              signals have no targeted-advertising opt-out to act on; we honor them as opt-outs of
              targeted advertising and the sale or sharing of personal information to the extent
              applicable.
            </P>
          </Section>

          <Section id="public-info" title="6. Publicly Visible Information">
            <P>
              LSR is a public-facing competition organization. The following information is
              visible on the Service to anyone who visits, including search engines:
            </P>
            <UL>
              <li>Your handle and display name</li>
              <li>Your profile photo, bio, iRating, and social media links (if you provide them)</li>
              <li>Your driver profile, including your event history and statistics</li>
              <li>Your race results, lap times, and championship standings</li>
              <li>Posts and pages you author with &ldquo;public&rdquo; visibility</li>
            </UL>
            <P>
              Information such as your email address, payment records, UT EID, and notification
              preferences is <span className="font-bold text-white">not</span> displayed publicly.
              You can control much of what is shown by editing your profile or by retiring or
              deleting your account (see Section 8).
            </P>
          </Section>

          <Section id="children" title="7. Children's Privacy">
            <P>
              The Service is intended for users at least 13 years of age. We do not knowingly
              collect personal information from children under 13. If you believe a child under
              13 has provided us with personal information, contact{" "}
              <a
                href={`mailto:${CONTACT_EMAIL}`}
                className="text-lsr-orange hover:underline font-medium"
              >
                {CONTACT_EMAIL}
              </a>{" "}
              and we will delete the information promptly.
            </P>
            <P>
              If you are between 13 and 18, you may use the Service only with the involvement
              and consent of a parent or legal guardian.
            </P>
          </Section>

          <Section id="your-rights" title="8. Your Rights and Choices">
            <SubSection title="8.1 Access and update">
              <P>
                You can view and update most of your personal information in your account
                settings.
              </P>
            </SubSection>

            <SubSection title="8.2 Email and notifications">
              <P>
                You control which emails we send you in your account&apos;s notification
                preferences. By default, when you create an account, you are subscribed to our
                event and club update emails; you can opt out at any time through your account
                or by using the unsubscribe link in any email we send.
              </P>
            </SubSection>

            <SubSection title="8.3 Retiring your account">
              <P>
                You may retire your account to make it inactive while keeping your profile and
                history visible. A retired account cannot register for new events or sign in.
              </P>
            </SubSection>

            <SubSection title="8.4 Deleting your account">
              <P>
                You may delete your account through your account settings. When you delete your
                account:
              </P>
              <UL>
                <li>
                  Your personally identifying information &mdash; including email, real name, UT EID,
                  profile photo, bio, and social links &mdash; is removed or anonymized
                </li>
                <li>
                  Your race results, event participation history, and championship standings are
                  retained under a generic &ldquo;Former Driver&rdquo; label to preserve the
                  integrity of historical leaderboards and competition records
                </li>
                <li>
                  Records we are required to keep for legal, tax, or audit purposes (such as
                  payment records and audit logs) are retained for the periods described in
                  Section 10
                </li>
                <li>
                  You will be permanently signed out and unable to log in to the deleted account
                </li>
              </UL>
              <P>
                If you would like a complete deletion of historical race data as well, contact{" "}
                <a
                  href={`mailto:${CONTACT_EMAIL}`}
                  className="text-lsr-orange hover:underline font-medium"
                >
                  {CONTACT_EMAIL}
                </a>{" "}
                with the subject &ldquo;Deletion Request&rdquo; and we will consider your request
                consistent with our legitimate interest in maintaining accurate historical
                competition records.
              </P>
            </SubSection>

            <SubSection title="8.5 Other requests">
              <P>
                To request a copy of your personal information, correct inaccurate information,
                restrict processing, or exercise any state-specific privacy right (see Section
                9), email{" "}
                <a
                  href={`mailto:${CONTACT_EMAIL}`}
                  className="text-lsr-orange hover:underline font-medium"
                >
                  {CONTACT_EMAIL}
                </a>{" "}
                with &ldquo;Privacy Request&rdquo; in the subject line. We may need to verify
                your identity before fulfilling certain requests.
              </P>
            </SubSection>
          </Section>

          <Section id="state-rights" title="9. U.S. State Privacy Rights">
            <SubSection title="9.1 California (CCPA/CPRA)">
              <P>
                California residents have the right to (a) know what personal information we
                collect, use, and disclose; (b) request a copy of personal information; (c)
                request deletion of personal information; (d) correct inaccurate personal
                information; (e) limit the use of sensitive personal information; (f) opt out of
                the sale or sharing of personal information for cross-context behavioral
                advertising; and (g) not be discriminated against for exercising these rights.
              </P>
              <P>
                We do not sell or share personal information for cross-context behavioral
                advertising. To exercise your rights, email{" "}
                <a
                  href={`mailto:${CONTACT_EMAIL}`}
                  className="text-lsr-orange hover:underline font-medium"
                >
                  {CONTACT_EMAIL}
                </a>{" "}
                with &ldquo;California Privacy Request&rdquo; in the subject. We will respond
                within 45 days. If we deny your request, you may appeal by replying to our
                response.
              </P>
            </SubSection>

            <SubSection title="9.2 Texas (TDPSA)">
              <P>
                Texas residents have the right under the Texas Data Privacy and Security Act to
                access, correct, delete, and obtain a copy of their personal data, and to opt out
                of targeted advertising, the sale of personal data, and certain forms of
                profiling. We do not engage in targeted advertising, sell personal data, or use
                personal data for solely automated decisions producing legal or similarly
                significant effects.
              </P>
              <P>
                To exercise these rights, email{" "}
                <a
                  href={`mailto:${CONTACT_EMAIL}`}
                  className="text-lsr-orange hover:underline font-medium"
                >
                  {CONTACT_EMAIL}
                </a>
                .
              </P>
            </SubSection>

            <SubSection title="9.3 Other U.S. states">
              <P>
                Residents of Virginia, Colorado, Connecticut, Utah, Oregon, Montana, and other
                states with comprehensive privacy laws may have similar rights. Contact us at{" "}
                <a
                  href={`mailto:${CONTACT_EMAIL}`}
                  className="text-lsr-orange hover:underline font-medium"
                >
                  {CONTACT_EMAIL}
                </a>{" "}
                to exercise them.
              </P>
            </SubSection>

            <SubSection title="9.4 Authorized agents">
              <P>
                Where permitted by law, you may designate an authorized agent to submit privacy
                requests on your behalf. We may require the agent to provide proof of
                authorization and may verify your identity directly.
              </P>
            </SubSection>
          </Section>

          <Section id="retention" title="10. Data Retention">
            <P>
              We retain personal information only for as long as needed to provide the Service or
              to meet legal, accounting, or reporting obligations. Our standard retention
              periods are:
            </P>
            <div className="overflow-x-auto border border-white/10 bg-white/[0.02] my-4">
              <table className="w-full text-left text-sm">
                <thead className="bg-white/5 font-sans font-black text-[10px] uppercase tracking-widest text-white/60">
                  <tr>
                    <th className="p-4">Category</th>
                    <th className="p-4">Retention</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5 font-sans text-white/70 align-top">
                  <tr>
                    <td className="p-4 font-bold text-white">Account profile data</td>
                    <td className="p-4">Until you delete or retire your account</td>
                  </tr>
                  <tr>
                    <td className="p-4 font-bold text-white">Event registrations and attendance</td>
                    <td className="p-4">
                      While your account is active; anonymized and retained for historical
                      purposes after deletion
                    </td>
                  </tr>
                  <tr>
                    <td className="p-4 font-bold text-white">Race results and telemetry</td>
                    <td className="p-4">
                      Indefinitely as part of the historical competition record; anonymized to
                      &ldquo;Former Driver&rdquo; after account deletion
                    </td>
                  </tr>
                  <tr>
                    <td className="p-4 font-bold text-white">Payment transaction records</td>
                    <td className="p-4">7 years (for tax and audit obligations)</td>
                  </tr>
                  <tr>
                    <td className="p-4 font-bold text-white">Audit and security logs</td>
                    <td className="p-4">Up to 7 years</td>
                  </tr>
                  <tr>
                    <td className="p-4 font-bold text-white">Email delivery logs</td>
                    <td className="p-4">Up to 1 year (Resend manages its own retention)</td>
                  </tr>
                  <tr>
                    <td className="p-4 font-bold text-white">Communications with us</td>
                    <td className="p-4">Up to 3 years</td>
                  </tr>
                  <tr>
                    <td className="p-4 font-bold text-white">Backups</td>
                    <td className="p-4">
                      Encrypted backups may retain data for up to 90 days beyond the active
                      record retention period
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <P>
              We may retain information longer when required by law, to defend or assert legal
              claims, or to address security incidents.
            </P>
          </Section>

          <Section id="security" title="11. Data Security">
            <P>We use reasonable administrative, technical, and physical safeguards, including:</P>
            <UL>
              <li>HTTPS/TLS encryption for all data transmitted between you and the Service</li>
              <li>Encrypted storage of credentials and sensitive data by our service providers</li>
              <li>Role-based access controls limiting administrative actions to authorized officers</li>
              <li>Audit logging for sensitive operations</li>
              <li>Vendor selection requiring industry-standard security commitments (e.g., SOC 2)</li>
            </UL>
            <P>
              No system can be perfectly secure. If we become aware of a security incident
              affecting your personal information, we will notify you and applicable regulators
              as required by law.
            </P>
          </Section>

          <Section id="international" title="12. International Users">
            <P>
              The Service is operated from the United States and is directed at users in the
              United States. If you access the Service from outside the United States, your
              information will be transferred to and processed in the United States, which may
              have data-protection laws different from those of your jurisdiction.
            </P>
            <P>
              The Service is not directed at residents of the European Economic Area, United
              Kingdom, Switzerland, or other jurisdictions with comprehensive cross-border
              data-protection regimes, and we do not offer the Service in those jurisdictions.
            </P>
          </Section>

          <Section id="third-party-links" title="13. Third-Party Links">
            <P>
              The Service contains links to third-party websites (for example, sponsor websites,
              social media platforms, and event partner sites). We are not responsible for the
              privacy practices or content of those websites. We encourage you to review the
              privacy policies of any third-party site you visit.
            </P>
          </Section>

          <Section id="changes" title="14. Changes to This Policy">
            <P>
              We may update this Privacy Policy from time to time. When we make material
              changes, we will update the &ldquo;Last Updated&rdquo; date at the top of this
              page. For significant changes, we will also post a notice on the Service or send
              an email to account holders. Your continued use of the Service after the changes
              take effect indicates your acceptance of the updated policy.
            </P>
          </Section>

          <Section id="contact" title="15. Contact Us">
            <P>
              Questions, requests, or concerns about this Privacy Policy or your personal
              information should be sent to:
            </P>
            <div className="border border-white/10 bg-white/[0.02] p-6 mt-2 not-prose">
              <div className="space-y-2 text-white/80">
                <p>
                  <span className="font-bold text-white">Longhorn Sim Racing</span>
                </p>
                <p>
                  <span className="font-bold text-white">Email:</span>{" "}
                  <a
                    href={`mailto:${CONTACT_EMAIL}`}
                    className="text-lsr-orange hover:underline font-medium"
                  >
                    {CONTACT_EMAIL}
                  </a>
                </p>
                <p className="text-sm text-white/60">
                  Use subject lines &ldquo;Privacy Request,&rdquo; &ldquo;California Privacy
                  Request,&rdquo; or &ldquo;Deletion Request&rdquo; as applicable for faster
                  routing.
                </p>
              </div>
            </div>
            <P className="text-xs text-white/40 italic pt-6">
              This Privacy Policy is offered in good faith to explain our practices. It is not
              legal advice. By using the Service, you agree to its terms.
            </P>
          </Section>
        </div>

        <div className="mt-20 pt-8 border-t border-white/10 flex items-center justify-between text-[11px] font-bold uppercase tracking-[0.2em] text-white/40">
          <span>
            Last Updated: <span className="text-white/70">{LAST_UPDATED}</span>
          </span>
          <Link href="/terms" className="text-lsr-orange hover:text-white transition-colors">
            Terms of Service &rarr;
          </Link>
        </div>
      </div>
    </main>
  )
}
