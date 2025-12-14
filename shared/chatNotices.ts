export type NoticeKind = "scope" | "disclaimer" | "system" | "error";

export type NoticeSeverity = "info" | "warning" | "error";

export interface ChatNotice {
  kind: NoticeKind;
  code: string;
  label: string;
  message: string;
  severity?: NoticeSeverity;
}

export const NOTICE_CODES = {
  LOCAL_SCOPE: "LOCAL_SCOPE",
  STATEWIDE_SCOPE: "STATEWIDE_SCOPE",
  MIXED_SCOPE: "MIXED_SCOPE",
  NO_DOCS: "NO_DOCS",
  INFO_ONLY: "INFO_ONLY",
  ARCHIVE_NOT_CONFIGURED: "ARCHIVE_NOT_CONFIGURED",
  HIGH_DEMAND: "HIGH_DEMAND",
  PROCESSING_ERROR: "PROCESSING_ERROR",
} as const;
