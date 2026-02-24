import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Bot, DollarSign, HelpCircle, Sparkles } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { TemplatePayload } from "@shared/schema";

export function TemplateFirstMessage({
  payload,
  title,
  onQuestionClick,
}: {
  payload: TemplatePayload;
  title: string;
  onQuestionClick: (question: string) => void;
}) {
  return (
    <div className="flex gap-4" data-testid="template-first-message">
      <div className="flex-shrink-0 w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center">
        <Bot className="w-4 h-4 text-primary" />
      </div>
      <div className="flex flex-col gap-3 max-w-3xl flex-1">
        <div className="rounded-lg px-4 py-3 bg-card border border-card-border">
          <h3 className="font-semibold text-base mb-3" data-testid="text-template-title">
            {title}
          </h3>

          <div className="prose prose-sm dark:prose-invert max-w-none mb-4">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {payload.summary}
            </ReactMarkdown>
          </div>

          <Separator className="my-4" />

          <Accordion type="multiple" className="w-full">
            {payload.sections.map((section, idx) => (
              <AccordionItem key={idx} value={`section-${idx}`} data-testid={`accordion-section-${idx}`}>
                <AccordionTrigger className="text-sm text-left">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span>{section.title}</span>
                    {section.budgetAmount && (
                      <Badge variant="secondary">
                        <DollarSign className="w-3 h-3 mr-1" />
                        {section.budgetAmount}
                      </Badge>
                    )}
                  </div>
                </AccordionTrigger>
                <AccordionContent>
                  <div className="space-y-3 pl-1">
                    <p className="text-sm text-muted-foreground">{section.description}</p>
                    <div className="flex flex-wrap gap-2">
                      {section.suggestedQuestions.map((q, qIdx) => (
                        <Badge
                          key={qIdx}
                          variant="outline"
                          className="cursor-pointer text-xs py-1.5 px-3"
                          onClick={() => onQuestionClick(q)}
                          data-testid={`chip-question-${idx}-${qIdx}`}
                        >
                          <HelpCircle className="w-3 h-3 mr-1 shrink-0" />
                          {q}
                        </Badge>
                      ))}
                    </div>
                  </div>
                </AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>

          {payload.highLevelQuestions.length > 0 && (
            <>
              <Separator className="my-4" />
              <div>
                <h4 className="text-sm font-medium mb-3 flex items-center gap-1">
                  <Sparkles className="w-4 h-4" />
                  Explore Further
                </h4>
                <div className="flex flex-wrap gap-2">
                  {payload.highLevelQuestions.map((q, idx) => (
                    <Badge
                      key={idx}
                      variant="outline"
                      className="cursor-pointer text-xs py-1.5 px-3"
                      onClick={() => onQuestionClick(q)}
                      data-testid={`chip-highlevel-${idx}`}
                    >
                      <Sparkles className="w-3 h-3 mr-1 shrink-0" />
                      {q}
                    </Badge>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>
        <p className="text-xs text-muted-foreground px-1">
          {new Date().toLocaleTimeString()}
        </p>
      </div>
    </div>
  );
}
