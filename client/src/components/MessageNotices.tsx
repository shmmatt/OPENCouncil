import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Info, AlertTriangle, AlertCircle } from "lucide-react";
import type { ChatNotice, NoticeSeverity } from "@shared/chatNotices";

interface MessageNoticesProps {
  notices: ChatNotice[];
}

function getSeverityIcon(severity: NoticeSeverity = "info") {
  switch (severity) {
    case "warning":
      return <AlertTriangle className="w-3 h-3" />;
    case "error":
      return <AlertCircle className="w-3 h-3" />;
    default:
      return <Info className="w-3 h-3" />;
  }
}

function getSeverityVariant(severity: NoticeSeverity = "info"): "default" | "secondary" | "destructive" | "outline" {
  switch (severity) {
    case "warning":
      return "secondary";
    case "error":
      return "destructive";
    default:
      return "outline";
  }
}

function NoticeBadge({ notice }: { notice: ChatNotice }) {
  const icon = getSeverityIcon(notice.severity);
  const variant = getSeverityVariant(notice.severity);

  const badge = (
    <Badge 
      variant={variant} 
      className="cursor-help flex items-center gap-1 text-xs"
      data-testid={`notice-badge-${notice.code}`}
    >
      {icon}
      <span>{notice.label}</span>
    </Badge>
  );

  return (
    <>
      <div className="hidden md:block">
        <Tooltip>
          <TooltipTrigger asChild>
            {badge}
          </TooltipTrigger>
          <TooltipContent 
            className="max-w-xs text-sm"
            data-testid={`notice-tooltip-${notice.code}`}
          >
            {notice.message}
          </TooltipContent>
        </Tooltip>
      </div>
      <div className="md:hidden">
        <Popover>
          <PopoverTrigger asChild>
            {badge}
          </PopoverTrigger>
          <PopoverContent 
            className="max-w-xs text-sm"
            data-testid={`notice-popover-${notice.code}`}
          >
            {notice.message}
          </PopoverContent>
        </Popover>
      </div>
    </>
  );
}

export function MessageNotices({ notices }: MessageNoticesProps) {
  if (!notices || notices.length === 0) return null;

  return (
    <div 
      className="flex flex-wrap gap-2 mt-1"
      data-testid="message-notices"
    >
      {notices.map((notice, idx) => (
        <NoticeBadge key={`${notice.code}-${idx}`} notice={notice} />
      ))}
    </div>
  );
}
