import Link from "next/link"
import { Metadata } from "next"

export const metadata: Metadata = {
  title: "Terms of Service",
  description:
    "The terms governing your use of the Longhorn Sim Racing platform, including events, payments, content, and the LSR shop.",
  alternates: {
    canonical: "/terms",
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
  { id: "acceptance", label: "1. Acceptance of These Terms" },
  { id: "about-lsr", label: "2. About Longhorn Sim Racing" },
  { id: "eligibility", label: "3. Eligibility" },
  { id: "accounts", label: "4. Accounts and Account Security" },
  { id: "events", label: "5. Events and Competition" },
  { id: "memberships", label: "6. Memberships and Dues" },
  { id: "payments", label: "7. Payments, Refunds, and Donations" },
  { id: "shop", label: "8. Merchandise and the LSR Shop" },
  { id: "user-content", label: "9. User Content" },
  { id: "acceptable-use", label: "10. Acceptable Use" },
  { id: "ip", label: "11. Intellectual Property" },
  { id: "dmca", label: "12. DMCA Copyright Policy" },
  { id: "third-party", label: "13. Third-Party Services" },
  { id: "disclaimers", label: "14. Disclaimers" },
  { id: "liability", label: "15. Limitation of Liability" },
  { id: "indemnification", label: "16. Indemnification" },
  { id: "termination", label: "17. Termination" },
  { id: "governing-law", label: "18. Governing Law and Dispute Resolution" },
  { id: "changes", label: "19. Changes to These Terms" },
  { id: "misc", label: "20. Miscellaneous" },
  { id: "contact", label: "21. Contact" },
]

export default function TermsPage() {
  return (
    <main className="bg-lsr-charcoal text-white min-h-screen">
      <div className="mx-auto max-w-4xl px-6 md:px-8 py-20 md:py-28">
        <h1 className="font-display font-black italic text-5xl md:text-7xl text-white uppercase tracking-normal leading-[0.9] mb-6">
          Terms of <span className="text-lsr-orange">Service</span>
        </h1>

        <div className="flex flex-wrap gap-x-8 gap-y-1 text-[11px] font-bold uppercase tracking-[0.2em] text-white/40 mb-12">
          <span>
            Effective: <span className="text-white/70">{EFFECTIVE_DATE}</span>
          </span>
          <span>
            Last Updated: <span className="text-white/70">{LAST_UPDATED}</span>
          </span>
        </div>

        <div className="border-l-4 border-lsr-orange bg-white/[0.02] p-6 md:p-7 mb-10">
          <p className="text-white/80 leading-relaxed text-[15px]">
            <span className="font-bold text-white">Please read these Terms carefully.</span> They
            include important information about how you may use the LSR platform, your rights and
            responsibilities, our disclaimers, limits on our liability, and how disputes are
            resolved (including which courts have jurisdiction and a waiver of class-action
            rights to the extent permitted by law).
          </p>
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
          <Section id="acceptance" title="1. Acceptance of These Terms">
            <P>
              These Terms of Service (&ldquo;Terms&rdquo;) form a binding agreement between you
              and Longhorn Sim Racing (&ldquo;LSR,&rdquo; &ldquo;we,&rdquo; &ldquo;us,&rdquo; or
              &ldquo;our&rdquo;) and govern your access to and use of the website at{" "}
              <a
                href="https://www.longhornsimracing.org"
                className="text-lsr-orange hover:underline font-medium"
              >
                www.longhornsimracing.org
              </a>{" "}
              and all related services, features, and content we provide (collectively, the
              &ldquo;Service&rdquo;).
            </P>
            <P>
              By accessing or using the Service, creating an account, registering for an event,
              or purchasing merchandise, you agree to be bound by these Terms and by our{" "}
              <Link href="/privacy" className="text-lsr-orange hover:underline font-medium">
                Privacy Policy
              </Link>
              . If you do not agree to these Terms, do not use the Service.
            </P>
          </Section>

          <Section id="about-lsr" title="2. About Longhorn Sim Racing">
            <P>
              LSR is a Texas nonprofit corporation recognized as a 501(c)(3) tax-exempt
              organization and a student organization affiliated with The University of Texas at
              Austin. The University is not a party to these Terms and is not responsible for
              your use of the Service.
            </P>
          </Section>

          <Section id="eligibility" title="3. Eligibility">
            <P>
              You must be at least 13 years old to use the Service. If you are between 13 and
              18, you may only use the Service with the consent and involvement of a parent or
              legal guardian who agrees to these Terms on your behalf and is responsible for your
              use of the Service.
            </P>
            <P>
              By using the Service you represent that:
            </P>
            <UL>
              <li>You meet the age requirements above</li>
              <li>You have the legal capacity to enter into these Terms</li>
              <li>Your use of the Service will not violate any applicable law or regulation</li>
              <li>
                You will comply with any policies of The University of Texas at Austin applicable
                to recognized student organizations, where relevant
              </li>
            </UL>
            <P>
              We may, in our discretion, refuse service, terminate accounts, or remove content
              for any reason consistent with applicable law.
            </P>
          </Section>

          <Section id="accounts" title="4. Accounts and Account Security">
            <SubSection title="4.1 Creating an account">
              <P>
                You may need to create an account to access parts of the Service. You agree to
                provide accurate and current information and to keep it updated. You may sign in
                using Google Sign-In or another authentication method we offer; your use of those
                services is subject to their own terms.
              </P>
            </SubSection>

            <SubSection title="4.2 One account per person">
              <P>
                Each user may maintain only one account. You may not share account credentials,
                create multiple accounts to manipulate registrations or results, or impersonate
                another person or entity.
              </P>
            </SubSection>

            <SubSection title="4.3 Account security">
              <P>
                You are responsible for safeguarding your account credentials and for all
                activity that occurs under your account. Notify us promptly at{" "}
                <a
                  href={`mailto:${CONTACT_EMAIL}`}
                  className="text-lsr-orange hover:underline font-medium"
                >
                  {CONTACT_EMAIL}
                </a>{" "}
                if you suspect unauthorized access.
              </P>
            </SubSection>
          </Section>

          <Section id="events" title="5. Events and Competition">
            <SubSection title="5.1 Registration">
              <P>
                You may register for LSR events through the Service. Some events have capacity
                limits, waitlists, eligibility criteria (such as iRacing license class or
                membership status), or other requirements. Registration may be subject to
                administrator approval and is not guaranteed.
              </P>
            </SubSection>

            <SubSection title="5.2 Rules and conduct">
              <P>
                All participants must follow LSR&apos;s racing rules, code of conduct, and any
                event-specific rules communicated by event organizers. Violations may result in
                penalties, time adjustments, disqualification, removal from the event, removal
                from results, or suspension or termination of your account.
              </P>
            </SubSection>

            <SubSection title="5.3 Race results and telemetry">
              <P>
                Race results you submit (including telemetry, replays, and supporting files) are
                subject to verification. We may correct, modify, withhold, or reject results that
                appear inaccurate, incomplete, fraudulent, or in violation of these Terms or our
                rules. Decisions of LSR&apos;s race control or officers regarding results are
                final.
              </P>
            </SubSection>

            <SubSection title="5.4 Cancellations and changes by LSR">
              <P>
                We may cancel, reschedule, or modify events for any reason, including
                insufficient participation, technical issues, safety, or external factors. We
                will make reasonable efforts to notify registered participants and, where
                applicable, refund event registration fees in accordance with Section 7.
              </P>
            </SubSection>

            <SubSection title="5.5 Risk acknowledgement">
              <P>
                Sim racing is a competitive activity that may involve eye strain, fatigue, and
                other physical or psychological stressors. You participate at your own risk and
                are responsible for ensuring your participation is safe for you. The Service is
                not a substitute for medical or professional advice.
              </P>
            </SubSection>
          </Section>

          <Section id="memberships" title="6. Memberships and Dues">
            <P>
              LSR may offer membership tiers with different benefits. Current membership in the
              Service does not require payment of dues. If paid membership tiers are introduced
              in the future, applicable fees, benefits, billing cadence, and refund terms will be
              presented to you before purchase and become part of these Terms upon your
              acceptance.
            </P>
            <P>
              Membership in LSR (the organization) is governed by our officers, bylaws, and any
              policies of The University of Texas at Austin applicable to recognized student
              organizations. We may grant, deny, suspend, or revoke membership consistent with
              those policies.
            </P>
          </Section>

          <Section id="payments" title="7. Payments, Refunds, and Donations">
            <SubSection title="7.1 Payment processors">
              <P>
                Paid event registrations are processed through Stripe. Sponsorship and donation
                payments may be processed through Venmo, PayPal, Stripe, or other providers we
                identify at the time of the transaction. Your use of these processors is subject
                to their own terms and privacy policies. We do not receive or store your full
                payment card information.
              </P>
            </SubSection>

            <SubSection title="7.2 Fees and taxes">
              <P>
                All fees are stated in U.S. dollars unless otherwise indicated. You are
                responsible for any taxes that apply to your purchases or donations. Donations
                are not goods or services, and no goods or services are provided in exchange for
                donations except as specifically described on the sponsorship page.
              </P>
            </SubSection>

            <SubSection title="7.3 Refunds">
              <P>Unless we state otherwise for a specific event or product:</P>
              <UL>
                <li>
                  Event registration fees are non-refundable once registration is confirmed,
                  except (i) when LSR cancels the event, in which case eligible fees will be
                  refunded to the original payment method, or (ii) where required by applicable
                  law
                </li>
                <li>Sponsorship and donation payments are non-refundable</li>
                <li>
                  Merchandise refunds and returns are governed by Section 8 and by the policies
                  of Shopify and Printful, our shop providers
                </li>
              </UL>
              <P>
                If you believe a charge was made in error, contact{" "}
                <a
                  href={`mailto:${CONTACT_EMAIL}`}
                  className="text-lsr-orange hover:underline font-medium"
                >
                  {CONTACT_EMAIL}
                </a>{" "}
                within 30 days and we will work with you to resolve the issue.
              </P>
            </SubSection>

            <SubSection title="7.4 Tax-deductibility of donations">
              <P>
                LSR is recognized by the Internal Revenue Service as a 501(c)(3) tax-exempt
                organization. Donations may be tax-deductible to the extent allowed by law. We
                will provide a donation receipt upon request. Consult your tax advisor regarding
                your specific situation.
              </P>
            </SubSection>
          </Section>

          <Section id="shop" title="8. Merchandise and the LSR Shop">
            <P>
              The LSR shop is operated through Shopify, with manufacturing and shipping handled
              by Printful, a print-on-demand provider. When you place an order:
            </P>
            <UL>
              <li>Shopify acts as the merchant of record and processes your payment</li>
              <li>Printful manufactures, packages, and ships your order</li>
              <li>
                The order, payment, and shipping information necessary to fulfill your order is
                shared with these providers
              </li>
            </UL>
            <P>
              Shipping times, product availability, and the appearance of finished products are
              subject to the policies and processes of Shopify and Printful. Because each item is
              made on demand:
            </P>
            <UL>
              <li>
                <span className="font-bold text-white">All sales are final</span> except in the
                case of (i) defective items, (ii) shipping errors (wrong item shipped), or (iii)
                damage in transit, in which case Printful&apos;s and Shopify&apos;s replacement
                policies apply
              </li>
              <li>
                We are not able to accept returns or exchanges for buyer&apos;s remorse, incorrect
                sizing chosen by the buyer, or other non-defect reasons
              </li>
              <li>
                Defects, errors, or damage must be reported within the timeframe required by
                Printful (typically 30 days from delivery)
              </li>
            </UL>
            <P>
              To report an order issue, email{" "}
              <a
                href={`mailto:${CONTACT_EMAIL}`}
                className="text-lsr-orange hover:underline font-medium"
              >
                {CONTACT_EMAIL}
              </a>{" "}
              with photos and your order number, and we will work with Shopify and Printful to
              resolve it.
            </P>
          </Section>

          <Section id="user-content" title="9. User Content">
            <SubSection title="9.1 What is User Content">
              <P>
                &ldquo;User Content&rdquo; means any content you submit, upload, post, or display
                through the Service, including profile photos, bios, social media links, posts,
                articles, race results, telemetry, replays, images, and comments.
              </P>
            </SubSection>

            <SubSection title="9.2 Ownership">
              <P>You retain ownership of your User Content.</P>
            </SubSection>

            <SubSection title="9.3 License you grant to LSR">
              <P>
                By submitting User Content, you grant LSR a worldwide, non-exclusive,
                royalty-free, sublicensable, and transferable license to use, host, store,
                reproduce, modify, adapt, publish, translate, distribute, publicly display, and
                publicly perform your User Content in connection with operating, promoting, and
                improving the Service and the activities of LSR (including in race broadcasts,
                social media, marketing materials, and event coverage). This license continues
                for as long as the User Content is part of historical race or event records, and
                survives termination of your account to the extent reasonably necessary to
                preserve those records.
              </P>
            </SubSection>

            <SubSection title="9.4 Your representations">
              <P>You represent and warrant that:</P>
              <UL>
                <li>You own or have all necessary rights to your User Content</li>
                <li>
                  Your User Content does not infringe any third party&apos;s intellectual
                  property, privacy, publicity, contractual, or other rights
                </li>
                <li>
                  Your User Content complies with these Terms and all applicable laws and
                  regulations
                </li>
              </UL>
            </SubSection>

            <SubSection title="9.5 Removal">
              <P>
                We may, in our discretion, refuse to publish, modify, or remove any User Content
                at any time, for any reason, including suspected violations of these Terms. We
                have no obligation to monitor User Content but reserve the right to do so.
              </P>
            </SubSection>

            <SubSection title="9.6 Feedback">
              <P>
                If you send us suggestions, ideas, or feedback about the Service, you grant us a
                perpetual, irrevocable, royalty-free license to use them for any purpose without
                obligation to you.
              </P>
            </SubSection>
          </Section>

          <Section id="acceptable-use" title="10. Acceptable Use">
            <P>You agree not to use the Service to:</P>
            <UL>
              <li>Violate any law, regulation, or third-party right</li>
              <li>
                Harass, threaten, stalk, defame, or discriminate against any person on any basis,
                including race, ethnicity, national origin, religion, sex, gender, gender
                identity, sexual orientation, age, disability, or any other protected
                characteristic
              </li>
              <li>Impersonate any person or entity or misrepresent your affiliation</li>
              <li>
                Submit false, misleading, or fraudulent information, including manipulated race
                results, telemetry, replays, or identity claims
              </li>
              <li>
                Cheat in or manipulate any competition (including using exploits, third-party
                cheats, or unauthorized telemetry modifications)
              </li>
              <li>
                Use automated tools, bots, scrapers, or other means to access, copy, or interact
                with the Service except through interfaces we expressly authorize
              </li>
              <li>
                Attempt to gain unauthorized access to the Service, other accounts, or our
                infrastructure
              </li>
              <li>
                Probe, scan, or test the vulnerability of the Service, or breach any security or
                authentication measures, except as part of a security disclosure program we
                authorize in writing
              </li>
              <li>
                Interfere with the operation of the Service, including by introducing malware,
                conducting denial-of-service activity, or overwhelming our infrastructure
              </li>
              <li>
                Reverse engineer, decompile, or attempt to extract source code, except as
                permitted by applicable law
              </li>
              <li>
                Use the Service to violate The University of Texas at Austin&apos;s policies,
                including the Institutional Rules on Student Services and Activities
              </li>
              <li>Sell, transfer, or otherwise commercialize your account or another user&apos;s data</li>
            </UL>
            <P>
              We may take any action we consider appropriate in response to a violation of this
              Section, including warnings, content removal, suspension, termination, and referral
              to law enforcement or university authorities.
            </P>
          </Section>

          <Section id="ip" title="11. Intellectual Property">
            <SubSection title="11.1 LSR content">
              <P>
                The Service and its original content (excluding User Content), including text,
                graphics, logos, the &ldquo;Longhorn Sim Racing&rdquo; name and marks, brand
                elements, and software, are owned by LSR or our licensors and are protected by
                U.S. and international intellectual property laws.
              </P>
            </SubSection>

            <SubSection title="11.2 Limited license to you">
              <P>
                Subject to your compliance with these Terms, we grant you a personal,
                non-exclusive, non-transferable, revocable license to access and use the Service
                for its intended purposes. All rights not expressly granted are reserved.
              </P>
            </SubSection>

            <SubSection title="11.3 Restrictions">
              <P>
                You may not copy, modify, distribute, sell, lease, or create derivative works of
                any part of the Service except as expressly permitted by us or by applicable law.
                You may not use our name, logos, or marks without our prior written consent,
                except to refer to LSR factually and accurately.
              </P>
            </SubSection>

            <SubSection title="11.4 Third-party marks">
              <P>
                Trademarks, logos, and brand names of third parties displayed on the Service
                (for example, sponsor logos, game titles such as iRacing or Assetto Corsa, and
                broadcast partner logos) are the property of their respective owners and are
                used with permission or under applicable fair-use principles.
              </P>
            </SubSection>
          </Section>

          <Section id="dmca" title="12. DMCA Copyright Policy">
            <P>
              LSR respects the intellectual property rights of others. If you believe that
              content on the Service infringes your copyright, send a written notice to our
              designated agent containing the following:
            </P>
            <UL>
              <li>Your physical or electronic signature</li>
              <li>
                Identification of the copyrighted work claimed to have been infringed (or a
                representative list if multiple works)
              </li>
              <li>
                Identification of the allegedly infringing material and information reasonably
                sufficient to locate it on the Service (such as a URL)
              </li>
              <li>
                Your contact information (name, mailing address, telephone number, email address)
              </li>
              <li>
                A statement that you have a good-faith belief that use of the material is not
                authorized by the copyright owner, its agent, or the law
              </li>
              <li>
                A statement, under penalty of perjury, that the information in your notice is
                accurate and that you are the copyright owner or authorized to act on behalf of
                the owner
              </li>
            </UL>
            <P>
              <span className="font-bold text-white">Designated agent:</span>{" "}
              <a
                href={`mailto:${CONTACT_EMAIL}`}
                className="text-lsr-orange hover:underline font-medium"
              >
                {CONTACT_EMAIL}
              </a>
              {" "}(subject line: &ldquo;DMCA Notice&rdquo;).
            </P>
            <P>
              We may remove or disable access to material that is the subject of a valid DMCA
              notice and will, in appropriate circumstances, terminate the accounts of repeat
              infringers. If you believe your material was removed by mistake, you may submit a
              counter-notice that meets the requirements of 17 U.S.C. &sect; 512(g).
            </P>
            <P className="text-xs text-white/40 italic">
              Misrepresentations in a DMCA notice or counter-notice may subject you to liability
              under 17 U.S.C. &sect; 512(f).
            </P>
          </Section>

          <Section id="third-party" title="13. Third-Party Services">
            <P>
              The Service relies on, links to, or integrates with third-party services
              (including Google, Supabase, Stripe, Shopify, Printful, Resend, Vercel,
              Cloudinary, iRacing, Assetto Corsa, Twitch, Discord, and others). We are not
              responsible for the content, policies, availability, or practices of these third
              parties. Your use of third-party services is at your own risk and subject to their
              own terms.
            </P>
          </Section>

          <Section id="disclaimers" title="14. Disclaimers">
            <P className="uppercase text-white/80 leading-relaxed">
              The Service is provided on an &ldquo;as is&rdquo; and &ldquo;as available&rdquo;
              basis without warranties of any kind, either express or implied. To the fullest
              extent permitted by law, LSR, its officers, members, volunteers, advisors, and
              agents disclaim all warranties, including but not limited to implied warranties of
              merchantability, fitness for a particular purpose, non-infringement, and any
              warranties arising out of course of dealing or usage of trade.
            </P>
            <P>We do not warrant that:</P>
            <UL>
              <li>The Service will be uninterrupted, timely, secure, or error-free</li>
              <li>The results obtained from the Service will be accurate or reliable</li>
              <li>Any defects in the Service will be corrected</li>
              <li>
                Race results, standings, statistics, or other information displayed on the Service
                are accurate, complete, or current
              </li>
            </UL>
            <P>
              Some jurisdictions do not allow the exclusion of certain warranties, so some of the
              above may not apply to you.
            </P>
          </Section>

          <Section id="liability" title="15. Limitation of Liability">
            <P className="uppercase text-white/80 leading-relaxed">
              To the fullest extent permitted by law, in no event will LSR or its officers,
              members, volunteers, advisors, or agents be liable for any indirect, incidental,
              special, consequential, exemplary, or punitive damages, or for any loss of profits,
              revenues, data, goodwill, or other intangible losses, arising out of or in
              connection with your access to or use of (or inability to access or use) the
              Service, whether based on warranty, contract, tort (including negligence), statute,
              or any other legal theory, and whether or not we have been advised of the
              possibility of such damages.
            </P>
            <P className="uppercase text-white/80 leading-relaxed">
              To the fullest extent permitted by law, our total cumulative liability for all
              claims relating to the Service will not exceed the greater of (a) the total amount
              you paid to LSR in the twelve (12) months before the event giving rise to the
              claim, or (b) one hundred U.S. dollars ($100).
            </P>
            <P>
              Some jurisdictions do not allow the exclusion or limitation of certain damages, so
              some of the above limitations may not apply to you. In such jurisdictions, our
              liability is limited to the maximum extent permitted by law.
            </P>
          </Section>

          <Section id="indemnification" title="16. Indemnification">
            <P>
              You agree to defend, indemnify, and hold harmless LSR and its officers, members,
              volunteers, advisors, and agents from and against any and all claims, liabilities,
              damages, losses, costs, and expenses (including reasonable attorneys&apos; fees and
              court costs) arising out of or in any way connected with:
            </P>
            <UL>
              <li>Your access to or use of the Service</li>
              <li>Your User Content</li>
              <li>Your violation of these Terms or any applicable law</li>
              <li>Your violation of any third-party right, including intellectual property and privacy rights</li>
              <li>Any disputes between you and another user</li>
            </UL>
            <P>
              We may, at our option, assume the exclusive defense and control of any matter
              otherwise subject to indemnification by you, and you agree to cooperate with our
              defense.
            </P>
          </Section>

          <Section id="termination" title="17. Termination">
            <P>
              You may stop using the Service at any time. You may delete or retire your account
              through your account settings; the effects of deletion are described in our{" "}
              <Link href="/privacy" className="text-lsr-orange hover:underline font-medium">
                Privacy Policy
              </Link>
              .
            </P>
            <P>
              We may suspend or terminate your account or your access to all or any part of the
              Service at any time, with or without notice, for any reason, including:
            </P>
            <UL>
              <li>Suspected or actual violation of these Terms</li>
              <li>Conduct we believe is harmful to LSR, our members, or other users</li>
              <li>Requirement by law, court order, or university policy</li>
              <li>Discontinuation of all or part of the Service</li>
            </UL>
            <P>
              Termination does not relieve you of obligations incurred before termination,
              including unpaid fees and obligations under Sections 9 (User Content license), 11
              (Intellectual Property), 14 (Disclaimers), 15 (Limitation of Liability), 16
              (Indemnification), 18 (Governing Law and Dispute Resolution), and 20
              (Miscellaneous), which survive termination.
            </P>
          </Section>

          <Section id="governing-law" title="18. Governing Law and Dispute Resolution">
            <SubSection title="18.1 Governing law">
              <P>
                These Terms and any dispute arising out of or relating to them or the Service are
                governed by the laws of the State of Texas and applicable U.S. federal law,
                without regard to conflict-of-laws principles.
              </P>
            </SubSection>

            <SubSection title="18.2 Informal resolution">
              <P>
                Before filing any legal claim against LSR, you agree to first contact us at{" "}
                <a
                  href={`mailto:${CONTACT_EMAIL}`}
                  className="text-lsr-orange hover:underline font-medium"
                >
                  {CONTACT_EMAIL}
                </a>{" "}
                with a description of the dispute and your contact information, and to attempt
                in good faith to resolve the dispute informally for at least thirty (30) days.
                Most concerns can be resolved this way.
              </P>
            </SubSection>

            <SubSection title="18.3 Jurisdiction and venue">
              <P>
                If informal resolution is unsuccessful, any dispute will be brought exclusively
                in the state or federal courts located in Travis County, Texas. You consent to
                the personal jurisdiction of those courts and waive any objection to venue.
              </P>
            </SubSection>

            <SubSection title="18.4 Waiver of class actions">
              <P className="uppercase text-white/80 leading-relaxed">
                To the fullest extent permitted by law, you and LSR agree that any dispute will
                be brought on an individual basis only and not as a plaintiff or class member in
                any purported class, collective, or representative proceeding.
              </P>
            </SubSection>

            <SubSection title="18.5 Time limit">
              <P>
                To the extent permitted by law, any claim arising out of or relating to these
                Terms or the Service must be filed within one (1) year after the cause of action
                arises, or it is permanently barred.
              </P>
            </SubSection>
          </Section>

          <Section id="changes" title="19. Changes to These Terms">
            <P>
              We may update these Terms from time to time. When we make material changes, we
              will update the &ldquo;Last Updated&rdquo; date at the top of this page. For
              significant changes, we will also post a notice on the Service or send an email to
              account holders. Your continued use of the Service after the changes take effect
              indicates your acceptance of the updated Terms. If you do not agree to the changes,
              you must stop using the Service and may delete your account.
            </P>
          </Section>

          <Section id="misc" title="20. Miscellaneous">
            <SubSection title="20.1 Entire agreement">
              <P>
                These Terms and our{" "}
                <Link href="/privacy" className="text-lsr-orange hover:underline font-medium">
                  Privacy Policy
                </Link>
                , together with any additional policies referenced (such as event-specific rules
                and racing rules), constitute the entire agreement between you and LSR regarding
                the Service.
              </P>
            </SubSection>

            <SubSection title="20.2 Severability">
              <P>
                If any provision of these Terms is held invalid, illegal, or unenforceable, the
                remaining provisions will remain in full force, and the unenforceable provision
                will be enforced to the maximum extent permitted by law.
              </P>
            </SubSection>

            <SubSection title="20.3 No waiver">
              <P>
                Our failure to enforce any provision of these Terms is not a waiver of that
                provision. A waiver is effective only if made in writing by an authorized officer
                of LSR.
              </P>
            </SubSection>

            <SubSection title="20.4 Assignment">
              <P>
                You may not assign or transfer these Terms or any rights under them without our
                prior written consent; any unauthorized assignment is void. We may assign these
                Terms, in whole or in part, to a successor entity (for example, upon merger or
                transfer of operations to another nonprofit) or to an affiliate.
              </P>
            </SubSection>

            <SubSection title="20.5 Relationship of the parties">
              <P>
                Nothing in these Terms creates any agency, partnership, joint venture, or
                employment relationship between you and LSR.
              </P>
            </SubSection>

            <SubSection title="20.6 Force majeure">
              <P>
                LSR is not liable for any failure or delay in performance caused by circumstances
                beyond our reasonable control, including acts of God, pandemics, natural
                disasters, war, terrorism, civil unrest, government actions, utility failures,
                internet outages, or failures of third-party service providers.
              </P>
            </SubSection>

            <SubSection title="20.7 Notices">
              <P>
                We may give you notices by email to the address associated with your account, by
                posting on the Service, or by any other reasonable means. You may give us notice
                by emailing{" "}
                <a
                  href={`mailto:${CONTACT_EMAIL}`}
                  className="text-lsr-orange hover:underline font-medium"
                >
                  {CONTACT_EMAIL}
                </a>
                .
              </P>
            </SubSection>

            <SubSection title="20.8 No third-party beneficiaries">
              <P>
                These Terms do not create any third-party beneficiary rights, except that the
                officers, members, volunteers, advisors, and agents of LSR are intended
                beneficiaries of Sections 14, 15, and 16.
              </P>
            </SubSection>

            <SubSection title="20.9 Headings">
              <P>
                Section headings are for convenience only and do not affect interpretation.
              </P>
            </SubSection>
          </Section>

          <Section id="contact" title="21. Contact">
            <P>Questions about these Terms? Contact us at:</P>
            <div className="border border-white/10 bg-white/[0.02] p-6 mt-2">
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
              </div>
            </div>
            <P className="text-xs text-white/40 italic pt-6">
              These Terms are provided in good faith. They are not legal advice. Your use of the
              Service constitutes acceptance of these Terms.
            </P>
          </Section>
        </div>

        <div className="mt-20 pt-8 border-t border-white/10 flex items-center justify-between text-[11px] font-bold uppercase tracking-[0.2em] text-white/40">
          <span>
            Last Updated: <span className="text-white/70">{LAST_UPDATED}</span>
          </span>
          <Link href="/privacy" className="text-lsr-orange hover:text-white transition-colors">
            &larr; Privacy Policy
          </Link>
        </div>
      </div>
    </main>
  )
}
