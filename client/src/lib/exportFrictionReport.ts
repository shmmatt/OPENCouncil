import { jsPDF } from "jspdf";
import { applyPlugin } from "jspdf-autotable";
import type {
  FrictionReportData,
  SitePlanApplication,
} from "@shared/schema";

applyPlugin(jsPDF);

declare module "jspdf" {
  interface jsPDF {
    autoTable: (options: any) => void;
    lastAutoTable: { finalY: number } | null;
  }
}

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function formatDate(dateStr?: string): string {
  if (!dateStr) return "N/A";
  try {
    return new Date(dateStr).toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return dateStr;
  }
}

function computeApprovalRate(apps: SitePlanApplication[]): string {
  if (apps.length === 0) return "N/A";
  const approved = apps.filter((a) =>
    ["approved", "approved_with_conditions"].includes(a.outcome)
  );
  return `${Math.round((approved.length / apps.length) * 100)}%`;
}

export function exportFrictionReportPDF(
  reportData: FrictionReportData,
  townName: string
) {
  const doc = new jsPDF({ orientation: "portrait", unit: "pt", format: "letter" });
  const pageWidth = doc.internal.pageSize.getWidth();
  const margin = 40;
  let y = margin;

  const addPageIfNeeded = (requiredSpace: number) => {
    if (y + requiredSpace > doc.internal.pageSize.getHeight() - margin) {
      doc.addPage();
      y = margin;
    }
  };

  const sectionTitle = (title: string) => {
    addPageIfNeeded(40);
    y += 16;
    doc.setFontSize(13);
    doc.setFont("helvetica", "bold");
    doc.text(title, margin, y);
    y += 8;
    doc.setDrawColor(180);
    doc.line(margin, y, pageWidth - margin, y);
    y += 12;
    doc.setFont("helvetica", "normal");
    doc.setFontSize(10);
  };

  doc.setFontSize(20);
  doc.setFont("helvetica", "bold");
  doc.text(`Development Friction Report`, margin, y);
  y += 24;
  doc.setFontSize(14);
  doc.text(townName, margin, y);
  y += 18;
  doc.setFontSize(9);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(100);
  const dateRange =
    reportData.dateRangeStart && reportData.dateRangeEnd
      ? `${formatDate(reportData.dateRangeStart)} - ${formatDate(reportData.dateRangeEnd)}`
      : "N/A";
  doc.text(`Date Range: ${dateRange}`, margin, y);
  y += 12;
  doc.text(`Generated: ${new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })}`, margin, y);
  y += 6;
  doc.setTextColor(0);

  sectionTitle("Summary Statistics");
  const apps = reportData.applications || [];
  const statsRows = [
    ["Unique Projects", String(apps.length)],
    ["Documents Analyzed", String(reportData.documentsAnalyzed ?? reportData.batchesProcessed ?? 0)],
    ["Agenda Items", String(reportData.chunksAnalyzed ?? 0)],
    ["Date Range", dateRange],
    ["Approval Rate", computeApprovalRate(apps)],
  ];
  doc.autoTable({
    startY: y,
    head: [["Metric", "Value"]],
    body: statsRows,
    margin: { left: margin, right: margin },
    styles: { fontSize: 9 },
    headStyles: { fillColor: [59, 130, 246] },
    theme: "grid",
  });
  y = doc.lastAutoTable!.finalY + 8;

  const funnelStages = reportData.funnelStages || [];
  const frictionMatrix = reportData.frictionMatrix || [];
  const predictiveInsights = reportData.predictiveInsights || [];

  if (funnelStages.length > 0) {
    sectionTitle("Site Plan Approval Funnel");
    doc.autoTable({
      startY: y,
      head: [["Stage", "Count", "Percentage"]],
      body: funnelStages.map((s) => [
        s.label,
        String(s.count),
        `${s.percentage.toFixed(1)}%`,
      ]),
      margin: { left: margin, right: margin },
      styles: { fontSize: 9 },
      headStyles: { fillColor: [59, 130, 246] },
      theme: "grid",
    });
    y = doc.lastAutoTable!.finalY + 8;
  }

  if (frictionMatrix.length > 0) {
    sectionTitle("Ordinance Friction Heatmap");
    doc.autoTable({
      startY: y,
      head: [["Category", "Count", "Percentage"]],
      body: frictionMatrix.map((f) => [
        f.category,
        String(f.count),
        `${f.percentage.toFixed(1)}%`,
      ]),
      margin: { left: margin, right: margin },
      styles: { fontSize: 9 },
      headStyles: { fillColor: [217, 119, 6] },
      theme: "grid",
    });
    y = doc.lastAutoTable!.finalY + 8;
  }

  if (reportData.ordinanceHitList && reportData.ordinanceHitList.length > 0) {
    sectionTitle("Ordinance Hit List");
    doc.autoTable({
      startY: y,
      head: [["Keyword", "Frequency", "Percentage"]],
      body: reportData.ordinanceHitList.map((o) => [
        o.keyword,
        String(o.count),
        `${o.percentage.toFixed(1)}%`,
      ]),
      margin: { left: margin, right: margin },
      styles: { fontSize: 9 },
      headStyles: { fillColor: [217, 119, 6] },
      theme: "grid",
    });
    y = doc.lastAutoTable!.finalY + 8;
  }

  if (reportData.timeToDecision) {
    sectionTitle("Time-to-Decision");
    const ttd = reportData.timeToDecision;
    const overviewRows = [
      ["Average Days", String(Math.round(ttd.overall.avgDays))],
      ["Median Days", String(Math.round(ttd.overall.medianDays))],
      ["Avg Continuances", String(ttd.overall.avgContinuances.toFixed(1))],
    ];
    doc.autoTable({
      startY: y,
      head: [["Metric", "Value"]],
      body: overviewRows,
      margin: { left: margin, right: margin },
      styles: { fontSize: 9 },
      headStyles: { fillColor: [59, 130, 246] },
      theme: "grid",
    });
    y = doc.lastAutoTable!.finalY + 6;

    if (ttd.byCategory.length > 0) {
      addPageIfNeeded(60);
      doc.setFontSize(10);
      doc.setFont("helvetica", "italic");
      doc.text("Breakdown by Friction Category", margin, y + 4);
      y += 10;
      doc.setFont("helvetica", "normal");
      doc.autoTable({
        startY: y,
        head: [["Category", "Avg Days", "Count"]],
        body: ttd.byCategory.map((c) => [
          c.category,
          String(Math.round(c.avgDays)),
          String(c.count),
        ]),
        margin: { left: margin, right: margin },
        styles: { fontSize: 9 },
        headStyles: { fillColor: [107, 114, 128] },
        theme: "grid",
      });
      y = doc.lastAutoTable!.finalY + 8;
    }
  }

  if (reportData.frequentFlyers && reportData.frequentFlyers.length > 0) {
    sectionTitle("Most Contested Projects");
    doc.autoTable({
      startY: y,
      head: [["Project", "Address", "Meetings", "Days", "Outcome"]],
      body: reportData.frequentFlyers.map((f) => [
        f.entityName,
        f.address || "N/A",
        String(f.meetingCount),
        String(f.daysElapsed),
        f.outcome,
      ]),
      margin: { left: margin, right: margin },
      styles: { fontSize: 8, cellPadding: 3 },
      headStyles: { fillColor: [239, 68, 68] },
      columnStyles: { 0: { cellWidth: 140 }, 1: { cellWidth: 120 } },
      theme: "grid",
    });
    y = doc.lastAutoTable!.finalY + 8;
  }

  if (reportData.developerScorecard && reportData.developerScorecard.length > 0) {
    sectionTitle("Frequent Applicants & Property Owners");
    doc.autoTable({
      startY: y,
      head: [["Applicant", "Projects", "Approval Rate", "Avg Days", "Avg Continuances"]],
      body: reportData.developerScorecard.map((d) => [
        d.applicantName,
        String(d.projectCount),
        `${d.approvalRate}%`,
        String(Math.round(d.avgDaysToDecision)),
        String(d.avgContinuances.toFixed(1)),
      ]),
      margin: { left: margin, right: margin },
      styles: { fontSize: 8, cellPadding: 3 },
      headStyles: { fillColor: [59, 130, 246] },
      theme: "grid",
    });
    y = doc.lastAutoTable!.finalY + 8;
  }

  if (reportData.temporalTrends && reportData.temporalTrends.yearlyBreakdown.length > 0) {
    sectionTitle("Year-over-Year Trends");
    doc.autoTable({
      startY: y,
      head: [["Year", "Total", "Approved", "Denied", "Withdrawn", "Abandoned", "Avg Days"]],
      body: reportData.temporalTrends.yearlyBreakdown.map((yr) => [
        String(yr.year),
        String(yr.total),
        String(yr.approved),
        String(yr.denied),
        String(yr.withdrawn),
        String(yr.abandoned),
        String(Math.round(yr.avgDays)),
      ]),
      margin: { left: margin, right: margin },
      styles: { fontSize: 8, cellPadding: 3 },
      headStyles: { fillColor: [107, 114, 128] },
      theme: "grid",
    });
    y = doc.lastAutoTable!.finalY + 6;

    if (reportData.temporalTrends.yoyDeltas) {
      const d = reportData.temporalTrends.yoyDeltas;
      const fmtPct = (v: number) => `${v > 0 ? "+" : ""}${v.toFixed(1)}%`;
      addPageIfNeeded(40);
      doc.setFontSize(10);
      doc.setFont("helvetica", "italic");
      doc.text(
        `Year-over-Year: Volume ${fmtPct(d.volumePct)}, Time-to-Decision ${fmtPct(d.ttdPct)}, Continuances ${fmtPct(d.continuancesPct)}`,
        margin,
        y + 4
      );
      y += 16;
      doc.setFont("helvetica", "normal");
    }
  }

  if (predictiveInsights.length > 0) {
    sectionTitle("Predictive Insights");
    doc.setFontSize(9);
    predictiveInsights.forEach((insight, i) => {
      const lines = doc.splitTextToSize(
        `${i + 1}. ${insight}`,
        pageWidth - margin * 2
      );
      addPageIfNeeded(lines.length * 12 + 8);
      doc.text(lines, margin, y);
      y += lines.length * 12 + 6;
    });
  }

  if (apps.length > 0) {
    sectionTitle("All Extracted Applications");
    doc.autoTable({
      startY: y,
      head: [["Entity", "Address", "Applicant", "Outcome", "First Seen", "Last Seen", "Continuances", "Friction"]],
      body: apps.map((a) => [
        a.entityName,
        a.address || "",
        a.applicant || "",
        a.outcome,
        formatDate(a.initialAppearanceDate),
        formatDate(a.lastAppearanceDate),
        String(a.totalContinuances),
        a.primaryFrictionReason || "",
      ]),
      margin: { left: margin, right: margin },
      styles: { fontSize: 7, cellPadding: 2, overflow: "linebreak" },
      headStyles: { fillColor: [59, 130, 246], fontSize: 7 },
      columnStyles: {
        0: { cellWidth: 90 },
        1: { cellWidth: 75 },
        2: { cellWidth: 65 },
        3: { cellWidth: 55 },
        7: { cellWidth: 80 },
      },
      theme: "grid",
    });
  }

  const safeFilename = townName.replace(/[^a-zA-Z0-9]/g, "_");
  const pdfBlob = doc.output("blob");
  triggerDownload(pdfBlob, `Friction_Report_${safeFilename}.pdf`);
}

function escapeCsvField(value: string): string {
  if (value.includes(",") || value.includes('"') || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export function exportFrictionReportCSV(
  reportData: FrictionReportData,
  townName: string
) {
  const headers = [
    "Entity Name",
    "Address",
    "Applicant",
    "Initial Appearance",
    "Last Appearance",
    "Outcome",
    "Total Continuances",
    "Primary Friction Reason",
    "Friction Categories",
    "Conditions",
    "Appeal Path",
    "Appeal Outcome",
    "Meeting References",
  ];

  const rows = (reportData.applications || []).map((a) => [
    a.entityName || "",
    a.address || "",
    a.applicant || "",
    a.initialAppearanceDate || "",
    a.lastAppearanceDate || "",
    a.outcome || "",
    String(a.totalContinuances ?? 0),
    a.primaryFrictionReason || "",
    (a.frictionCategories || []).join("; "),
    (a.conditions || []).join("; "),
    a.appealPath || "",
    a.appealOutcome || "",
    (a.meetingReferences || []).join("; "),
  ]);

  const csvContent =
    headers.map(escapeCsvField).join(",") +
    "\n" +
    rows.map((row) => row.map(escapeCsvField).join(",")).join("\n");

  const blob = new Blob(["\uFEFF" + csvContent], {
    type: "text/csv;charset=utf-8;",
  });
  const safeFilename = townName.replace(/[^a-zA-Z0-9]/g, "_");
  triggerDownload(blob, `Friction_Report_${safeFilename}.csv`);
}
