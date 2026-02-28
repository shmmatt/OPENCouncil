import { jsPDF } from "jspdf";
import { applyPlugin } from "jspdf-autotable";
import type {
  FrictionReportData,
  SitePlanApplication,
  RepresentationGapData,
  ProjectTypeComparisonData,
  AttritionCurveEntry,
  DelayBreakdownData,
  StandardConditionEntry,
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
    ["Date Range", dateRange],
    ["Approval Rate (all apps)", computeApprovalRate(apps)],
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

  if (reportData.representationGap && (reportData.representationGap.citizenStats.count > 0 || reportData.representationGap.proStats.count > 0)) {
    sectionTitle("The Representation Gap");
    const gap = reportData.representationGap;
    doc.autoTable({
      startY: y,
      head: [["Metric", "Citizen/Owner", "Professional", "Delta"]],
      body: [
        ["Approval Rate", `${gap.citizenStats.approvalRate}%`, `${gap.proStats.approvalRate}%`, `${gap.delta.approvalRate > 0 ? "+" : ""}${gap.delta.approvalRate}pp`],
        ["Continuance Rate", `${gap.citizenStats.continuanceRate}%`, `${gap.proStats.continuanceRate}%`, `${gap.delta.continuanceRate > 0 ? "+" : ""}${gap.delta.continuanceRate}pp`],
        ["Abandonment Rate", `${gap.citizenStats.abandonmentRate}%`, `${gap.proStats.abandonmentRate}%`, `${gap.delta.abandonmentRate > 0 ? "+" : ""}${gap.delta.abandonmentRate}pp`],
        ["Avg Days to Decision", String(gap.citizenStats.avgDaysToDecision), String(gap.proStats.avgDaysToDecision), `${gap.delta.avgDaysToDecision > 0 ? "+" : ""}${gap.delta.avgDaysToDecision} days`],
      ],
      margin: { left: margin, right: margin },
      styles: { fontSize: 9 },
      headStyles: { fillColor: [59, 130, 246] },
      theme: "grid",
    });
    y = doc.lastAutoTable!.finalY + 8;
  }

  if (reportData.projectTypeComparison) {
    const ptc = reportData.projectTypeComparison;
    const ptcRows: string[][] = [];
    if (ptc.residential.count > 0) ptcRows.push(["Residential", String(ptc.residential.count), String(ptc.residential.avgDays), String(ptc.residential.avgContinuances), ptc.residential.topFriction.join(", ") || "—"]);
    if (ptc.commercial.count > 0) ptcRows.push(["Commercial", String(ptc.commercial.count), String(ptc.commercial.avgDays), String(ptc.commercial.avgContinuances), ptc.commercial.topFriction.join(", ") || "—"]);
    if (ptc.mixedUse.count > 0) ptcRows.push(["Mixed-Use", String(ptc.mixedUse.count), String(ptc.mixedUse.avgDays), String(ptc.mixedUse.avgContinuances), ptc.mixedUse.topFriction.join(", ") || "—"]);
    if (ptcRows.length > 0) {
      sectionTitle("Residential vs. Commercial Timelines");
      doc.autoTable({
        startY: y,
        head: [["Project Type", "Count", "Avg Days", "Avg Cont.", "Top Friction"]],
        body: ptcRows,
        margin: { left: margin, right: margin },
        styles: { fontSize: 9 },
        headStyles: { fillColor: [59, 130, 246] },
        theme: "grid",
      });
      y = doc.lastAutoTable!.finalY + 8;
    }
  }

  if (reportData.attritionCurve && reportData.attritionCurve.length > 0) {
    sectionTitle("The Attrition Curve");
    doc.autoTable({
      startY: y,
      head: [["Exit Stage", "Count", "Percentage"]],
      body: reportData.attritionCurve.map((e) => [
        e.stage,
        String(e.count),
        `${e.percentage}%`,
      ]),
      margin: { left: margin, right: margin },
      styles: { fontSize: 9 },
      headStyles: { fillColor: [239, 68, 68] },
      theme: "grid",
    });
    y = doc.lastAutoTable!.finalY + 8;
  }

  if (reportData.delayBreakdown && reportData.delayBreakdown.avgTotalDays > 0) {
    sectionTitle("State vs. Local Delays (Estimated)");
    const db = reportData.delayBreakdown;
    doc.autoTable({
      startY: y,
      head: [["Metric", "Days"]],
      body: [
        ["Est. Board Review Days", String(db.avgBoardDays)],
        ["Est. External/State Delay Days", String(db.avgExternalDays)],
        ["Total Avg Days", String(db.avgTotalDays)],
      ],
      margin: { left: margin, right: margin },
      styles: { fontSize: 9 },
      headStyles: { fillColor: [217, 119, 6] },
      theme: "grid",
    });
    y = doc.lastAutoTable!.finalY + 4;
    if (db.externalReasons.length > 0) {
      doc.autoTable({
        startY: y,
        head: [["External Delay Reason", "Applications"]],
        body: db.externalReasons.map((r) => [r.reason, String(r.count)]),
        margin: { left: margin, right: margin },
        styles: { fontSize: 8, cellPadding: 3 },
        headStyles: { fillColor: [217, 119, 6] },
        theme: "grid",
      });
      y = doc.lastAutoTable!.finalY + 8;
    }
  }

  if (reportData.standardConditions && reportData.standardConditions.length > 0) {
    sectionTitle("Standard Conditions — Pre-Application Checklist Candidates");
    doc.autoTable({
      startY: y,
      head: [["Condition", "Count", "% of Approved"]],
      body: reportData.standardConditions.map((c) => [
        c.condition,
        String(c.count),
        `${c.percentage}%`,
      ]),
      margin: { left: margin, right: margin },
      styles: { fontSize: 8, cellPadding: 3, overflow: "linebreak" as const },
      headStyles: { fillColor: [59, 130, 246] },
      columnStyles: { 0: { cellWidth: 300 } },
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
  const EXTERNAL_TRIGGERS = [
    "nhdot", "nhdes", "nhb", "state", "dot review", "des review",
    "wetland", "shoreland", "alteration of terrain", "aot",
    "traffic study", "traffic impact", "peer review",
    "nh fish", "fish and game",
  ];

  function computeAttritionStage(app: SitePlanApplication): string {
    if (app.outcome !== "withdrawn" && app.outcome !== "abandoned") return "";
    const cont = app.totalContinuances ?? 0;
    const frictionLower = (app.primaryFrictionReason || "").toLowerCase();
    const conditionsLower = (app.conditions || []).join(" ").toLowerCase();
    const combined = frictionLower + " " + conditionsLower;
    if (EXTERNAL_TRIGGERS.some((t) => combined.includes(t))) {
      return "External/State Trigger";
    }
    if (cont === 0) return "Before First Hearing";
    if (cont === 1) return "After 1 Continuance";
    if (cont <= 3) return "After 2-3 Continuances";
    return "After 4+ Continuances";
  }

  const headers = [
    "Entity Name",
    "Address",
    "Applicant",
    "Project Type",
    "Applicant Type",
    "Initial Appearance",
    "Last Appearance",
    "Outcome",
    "Attrition Stage",
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
    a.projectType || "",
    a.applicantType || "",
    a.initialAppearanceDate || "",
    a.lastAppearanceDate || "",
    a.outcome || "",
    computeAttritionStage(a),
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
