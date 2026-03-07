import { Link } from "wouter";
import {
  Landmark,
  Search,
  GraduationCap,
  Quote,
  ShieldCheck,
  CircleHelp,
  BookOpen,
  MapPin,
  RefreshCw,
  ArrowRight,
  Rss,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

const useCases = [
  {
    title: "Understand Zoning Laws",
    description:
      "Instantly look up the specific NH RSA or local ordinance behind a property setback, building code, or land-use regulation.",
    icon: Landmark,
    testId: "card-usecase-zoning",
  },
  {
    title: "Track Board Decisions",
    description:
      "Find exactly what the Planning Board or Select Board decided about a local project without reading months of meeting minutes.",
    icon: Search,
    testId: "card-usecase-decisions",
  },
  {
    title: "Follow School Budgets",
    description:
      "Track SAU spending discussions and school board budget deliberations across different meetings and member towns.",
    icon: GraduationCap,
    testId: "card-usecase-school",
  },
];

const steps = [
  {
    number: "1",
    title: "We Gather the Public Record",
    description:
      "OPENCouncil automatically collects official meeting minutes, ordinances, and budgets directly from local town and school district websites.",
    testId: "step-gather",
  },
  {
    number: "2",
    title: "You Ask a Question",
    description:
      "Type your question exactly how you'd ask a town clerk. No special syntax, no keywords to memorize.",
    testId: "step-ask",
  },
  {
    number: "3",
    title: "We Search Locally and Statewide",
    description:
      "The system checks your specific town's records while simultaneously checking New Hampshire state law to give you the full picture.",
    testId: "step-search",
  },
  {
    number: "4",
    title: "You Get a Clear Answer with Proof",
    description:
      "You receive a plain-English summary alongside direct references to the exact documents so you can verify it yourself.",
    testId: "step-answer",
  },
];

const trustPillars = [
  {
    title: "Always Showing Our Work",
    description:
      "Every single claim includes a citation back to the source document. We never ask you to just trust the system — we take you straight to the record.",
    icon: Quote,
    testId: "card-trust-citations",
  },
  {
    title: "Strict Fact-Checking",
    description:
      "Before you see an answer, the system double-checks its own work against the public record to make sure statutes and local rules aren't misrepresented.",
    icon: ShieldCheck,
    testId: "card-trust-factcheck",
  },
  {
    title: "Honest About Its Limits",
    description:
      "If the answer isn't in the public record, OPENCouncil will tell you it doesn't know. It doesn't guess, and it doesn't pull from unverified outside sources.",
    icon: CircleHelp,
    testId: "card-trust-limits",
  },
];

export default function Landing() {
  return (
    <div className="min-h-screen flex flex-col">
      <section className="relative flex items-center justify-center px-6 py-32 md:py-44 bg-[hsl(212,60%,25%)]">
        <div className="absolute inset-0 bg-gradient-to-b from-black/60 to-black/30" />
        <div className="relative z-10 max-w-3xl mx-auto text-center">
          <p
            className="text-sm font-medium tracking-widest uppercase text-white/60 mb-3"
            data-testid="text-hero-label"
          >
            OPENCouncil
          </p>
          <h1
            className="text-4xl md:text-5xl font-bold text-white tracking-tight"
            data-testid="text-hero-title"
          >
            Clear Answers for Your Community.
          </h1>
          <p
            className="mt-5 text-base md:text-lg text-white/80 max-w-2xl mx-auto leading-relaxed"
            data-testid="text-hero-subtitle"
          >
            OPENCouncil makes it easy to search and understand New Hampshire
            municipal documents, state laws, and school board records. Built
            locally to help citizens, elected officials, and town employees make
            informed decisions.
          </p>
          <div className="mt-8 flex items-center justify-center gap-4 flex-wrap">
            <Button asChild size="lg" data-testid="link-cta-chat">
              <Link href="/chat">
                Ask a Question
                <ArrowRight className="ml-2 h-4 w-4" />
              </Link>
            </Button>
            <Button asChild size="lg" variant="outline" className="backdrop-blur-sm bg-white/10 border-white/30 text-white" data-testid="link-landing-feed">
              <Link href="/feed">
                <Rss className="mr-2 h-4 w-4" />
                See What's Happening
              </Link>
            </Button>
          </div>
        </div>
      </section>

      <section className="bg-background px-6 py-16 md:py-20" data-testid="section-usecases">
        <div className="max-w-5xl mx-auto">
          <h2
            className="text-2xl md:text-3xl font-semibold text-center mb-3"
            data-testid="text-usecases-heading"
          >
            What You Can Do
          </h2>
          <p className="text-center text-muted-foreground mb-10 max-w-2xl mx-auto" data-testid="text-usecases-subtitle">
            Real questions. Real answers. Backed by real documents.
          </p>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            {useCases.map((uc) => (
              <Card key={uc.title} data-testid={uc.testId}>
                <CardContent className="pt-6">
                  <div className="flex items-start gap-3">
                    <div className="rounded-md bg-primary/10 p-2 shrink-0">
                      <uc.icon className="h-5 w-5 text-primary" />
                    </div>
                    <div>
                      <h3 className="font-semibold mb-1">{uc.title}</h3>
                      <p className="text-sm text-muted-foreground leading-relaxed">
                        {uc.description}
                      </p>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      </section>

      <section className="bg-muted/50 px-6 py-16 md:py-20" data-testid="section-howitworks">
        <div className="max-w-4xl mx-auto">
          <h2
            className="text-2xl md:text-3xl font-semibold text-center mb-3"
            data-testid="text-howitworks-heading"
          >
            How It Works
          </h2>
          <p className="text-center text-muted-foreground mb-12 max-w-2xl mx-auto" data-testid="text-howitworks-subtitle">
            No technical knowledge required. Just ask.
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
            {steps.map((step) => (
              <div
                key={step.number}
                className="flex items-start gap-4"
                data-testid={step.testId}
              >
                <div className="flex items-center justify-center rounded-full bg-primary text-primary-foreground h-8 w-8 text-sm font-bold shrink-0">
                  {step.number}
                </div>
                <div>
                  <h3 className="font-semibold mb-1">{step.title}</h3>
                  <p className="text-sm text-muted-foreground leading-relaxed">
                    {step.description}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="bg-background px-6 py-16 md:py-20" data-testid="section-trust">
        <div className="max-w-5xl mx-auto">
          <h2
            className="text-2xl md:text-3xl font-semibold text-center mb-3"
            data-testid="text-trust-heading"
          >
            Why You Can Trust It
          </h2>
          <p className="text-center text-muted-foreground mb-10 max-w-2xl mx-auto" data-testid="text-trust-subtitle">
            This isn't a chatbot making things up. Every answer is accountable
            to the public record.
          </p>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            {trustPillars.map((pillar) => (
              <Card key={pillar.title} data-testid={pillar.testId}>
                <CardContent className="pt-6">
                  <div className="flex items-start gap-3">
                    <div className="rounded-md bg-primary/10 p-2 shrink-0">
                      <pillar.icon className="h-5 w-5 text-primary" />
                    </div>
                    <div>
                      <h3 className="font-semibold mb-1">{pillar.title}</h3>
                      <p className="text-sm text-muted-foreground leading-relaxed">
                        {pillar.description}
                      </p>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      </section>

      <section className="bg-muted/50 px-6 py-16 md:py-20" data-testid="section-coverage">
        <div className="max-w-4xl mx-auto">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-12 items-start">
            <div>
              <div className="flex items-center gap-3 mb-4 flex-wrap">
                <BookOpen className="h-6 w-6 text-primary" />
                <h2
                  className="text-2xl font-semibold"
                  data-testid="text-coverage-heading"
                >
                  What's in the Library
                </h2>
              </div>
              <p className="text-muted-foreground leading-relaxed mb-4" data-testid="text-coverage-description">
                OPENCouncil searches across a wide range of official public records, all in one place:
              </p>
              <ul className="space-y-2 text-sm text-muted-foreground" data-testid="list-coverage-items">
                <li className="flex items-start gap-2" data-testid="list-item-minutes">
                  <span className="text-primary mt-0.5">&#8226;</span>
                  Town meeting minutes and agendas
                </li>
                <li className="flex items-start gap-2" data-testid="list-item-zoning">
                  <span className="text-primary mt-0.5">&#8226;</span>
                  Zoning ordinances and land-use regulations
                </li>
                <li className="flex items-start gap-2" data-testid="list-item-budgets">
                  <span className="text-primary mt-0.5">&#8226;</span>
                  Municipal budgets and warrant articles
                </li>
                <li className="flex items-start gap-2" data-testid="list-item-reports">
                  <span className="text-primary mt-0.5">&#8226;</span>
                  Town annual reports
                </li>
                <li className="flex items-start gap-2" data-testid="list-item-rsas">
                  <span className="text-primary mt-0.5">&#8226;</span>
                  New Hampshire RSAs (state law)
                </li>
                <li className="flex items-start gap-2" data-testid="list-item-nhma">
                  <span className="text-primary mt-0.5">&#8226;</span>
                  NHMA guidance and legal interpretations
                </li>
                <li className="flex items-start gap-2" data-testid="list-item-sau">
                  <span className="text-primary mt-0.5">&#8226;</span>
                  SAU and school board documents
                </li>
              </ul>
            </div>
            <div>
              <div className="flex items-center gap-3 mb-4 flex-wrap">
                <MapPin className="h-6 w-6 text-primary" />
                <h2
                  className="text-2xl font-semibold"
                  data-testid="text-area-heading"
                >
                  Coverage Area
                </h2>
              </div>
              <p className="text-muted-foreground leading-relaxed mb-4" data-testid="text-area-description">
                OPENCouncil currently covers towns across <span className="font-medium text-foreground">Carroll County</span>, including
                Conway, Wolfeboro, Ossipee, Tamworth, Bartlett, Jackson, and more.
              </p>
              <p className="text-muted-foreground leading-relaxed mb-4" data-testid="text-area-statewide">
                Statewide resources like NH RSAs and NHMA guidance are available
                regardless of which town you're researching.
              </p>
              <div className="flex items-center gap-3 mt-6 flex-wrap">
                <RefreshCw className="h-6 w-6 text-primary" />
                <h2
                  className="text-2xl font-semibold"
                  data-testid="text-freshness-heading"
                >
                  Always Current
                </h2>
              </div>
              <p className="text-muted-foreground leading-relaxed mt-4" data-testid="text-freshness-description">
                Town governance moves fast. OPENCouncil automatically visits
                municipal websites to collect new documents as soon as they're
                posted, so you're always searching the most current public record
                available.
              </p>
              <p className="text-sm text-muted-foreground/70 mt-4 italic" data-testid="text-expansion-note">
                Expanding to the rest of New Hampshire soon.
              </p>
            </div>
          </div>
        </div>
      </section>

      <section className="bg-[hsl(212,60%,25%)] px-6 py-14 md:py-16" data-testid="section-cta-bottom">
        <div className="relative">
          <div className="absolute inset-0 bg-gradient-to-b from-black/40 to-black/20" />
          <div className="relative z-10 max-w-2xl mx-auto text-center">
            <h2
              className="text-2xl md:text-3xl font-semibold text-white mb-3"
              data-testid="text-cta-heading"
            >
              Ready to try it?
            </h2>
            <p className="text-white/75 mb-6" data-testid="text-cta-description">
              Ask OPENCouncil a question about your town. It's free and takes
              seconds.
            </p>
            <Button asChild size="lg" data-testid="link-cta-chat-bottom">
              <Link href="/chat">
                Ask a Question
                <ArrowRight className="ml-2 h-4 w-4" />
              </Link>
            </Button>
          </div>
        </div>
      </section>

      <footer className="bg-muted px-6 py-8">
        <p
          className="text-center text-sm text-muted-foreground max-w-2xl mx-auto"
          data-testid="text-ai-disclaimer"
        >
          OPENCouncil uses AI to help you find information faster. It is a
          research tool, not legal counsel. Always verify answers with official
          town records before making governance decisions.
        </p>
      </footer>
    </div>
  );
}
