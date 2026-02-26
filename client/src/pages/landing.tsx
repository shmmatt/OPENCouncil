import { Link } from "wouter";
import { FileText, MapPin, Link2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";

const features = [
  {
    title: "Document-Grounded Answers",
    description: "No guesswork. Every response is fact-checked against official town records.",
    icon: FileText,
    testId: "card-feature-document-grounded",
  },
  {
    title: "Town-Specific Intelligence",
    description: "Search across ordinances, budgets, and meeting minutes for your specific New Hampshire town.",
    icon: MapPin,
    testId: "card-feature-town-specific",
  },
  {
    title: "Complete Citation Trail",
    description: "Every answer includes source citations so you can verify the information yourself.",
    icon: Link2,
    testId: "card-feature-citation-trail",
  },
];

export default function Landing() {
  return (
    <div className="min-h-screen flex flex-col">
      <section className="relative flex items-center justify-center px-6 py-32 md:py-44 bg-[hsl(212,60%,25%)]">
        <div className="absolute inset-0 bg-gradient-to-b from-black/60 to-black/30" />
        <div className="relative z-10 max-w-3xl mx-auto text-center">
          <h1
            className="text-4xl md:text-5xl font-bold text-white tracking-tight"
            data-testid="text-hero-title"
          >
            OPENCouncil
          </h1>
          <p
            className="mt-4 text-lg md:text-xl text-white/90 font-medium"
            data-testid="text-hero-tagline"
          >
            Don't Read the Town Warrant. Ask It.
          </p>
          <p
            className="mt-3 text-base md:text-lg text-white/75 max-w-2xl mx-auto"
            data-testid="text-hero-subtitle"
          >
            Get instant, verifiable answers about your town's budgets, zoning laws, and meeting minutes — backed by the official documents.
          </p>
          <div className="mt-8">
            <Button asChild size="lg" data-testid="link-cta-chat">
              <Link href="/chat">Get Started</Link>
            </Button>
          </div>
        </div>
      </section>

      <section className="flex-1 bg-background px-6 py-16 md:py-20">
        <div className="max-w-5xl mx-auto">
          <h2
            className="text-2xl md:text-3xl font-semibold text-center mb-10"
            data-testid="text-features-heading"
          >
            How OPENCouncil Helps You
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            {features.map((feature) => (
              <Card key={feature.title} data-testid={feature.testId}>
                <CardHeader>
                  <div className="flex items-center gap-3 flex-wrap">
                    <feature.icon className="h-6 w-6 text-primary" />
                    <CardTitle className="text-lg">{feature.title}</CardTitle>
                  </div>
                </CardHeader>
                <CardContent>
                  <CardDescription className="text-sm">
                    {feature.description}
                  </CardDescription>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      </section>

      <footer className="bg-muted px-6 py-8">
        <p
          className="text-center text-sm text-muted-foreground max-w-2xl mx-auto"
          data-testid="text-ai-disclaimer"
        >
          OPENCouncil uses AI to help you find information faster. Always verify answers with official town records before making governance decisions.
        </p>
      </footer>
    </div>
  );
}
