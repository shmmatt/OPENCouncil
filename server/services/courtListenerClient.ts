const COURTLISTENER_API_TOKEN = process.env.COURTLISTENER_API_TOKEN || '';
const CL_BASE = 'https://www.courtlistener.com/api/rest/v4';
const CL_SITE = 'https://www.courtlistener.com';
const USER_AGENT = 'OPENCouncil/1.0 (NH Municipal Assistant)';
const REQUEST_DELAY_MS = 750;

export function isCourtListenerConfigured(): boolean {
  return COURTLISTENER_API_TOKEN.length > 0;
}

function getHeaders(): Record<string, string> {
  return {
    'Authorization': `Token ${COURTLISTENER_API_TOKEN}`,
    'User-Agent': USER_AGENT,
    'Accept': 'application/json',
  };
}

async function clFetch<T>(url: string): Promise<T | null> {
  try {
    const response = await fetch(url, { headers: getHeaders() });
    if (!response.ok) {
      console.warn(`[CourtListener] ${response.status} for ${url}`);
      return null;
    }
    return await response.json() as T;
  } catch (e: any) {
    console.warn(`[CourtListener] fetch error for ${url}: ${e.message}`);
    return null;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

export interface CLPaginatedResponse<T> {
  count: number | string;
  next: string | null;
  previous: string | null;
  results: T[];
}

export interface CLCluster {
  id: number;
  absolute_url: string;
  case_name: string;
  case_name_full: string;
  case_name_short: string;
  date_filed: string;
  date_created: string;
  date_modified: string;
  slug: string;
  docket_id: number;
  sub_opinions: string[];
  citation_count: number;
  precedential_status: string;
  judges: string;
  nature_of_suit: string;
  syllabus: string;
  headnotes: string;
  summary: string;
  disposition: string;
  attorneys: string;
  posture: string;
  source: string;
}

export interface CLOpinion {
  id: number;
  absolute_url: string;
  cluster_id: number;
  cluster: string;
  type: string;
  plain_text: string;
  html: string;
  html_with_citations: string;
  html_lawbox: string;
  html_columbia: string;
  sha1: string;
  page_count: number | null;
  download_url: string | null;
  per_curiam: boolean;
  author_str: string;
  extracted_by_ocr: boolean;
}

export interface FetchClustersParams {
  courtId?: string;
  dateFiledAfter?: string;
  dateFiledBefore?: string;
  pageSize?: number;
  orderBy?: string;
}

export async function fetchClusters(
  params: FetchClustersParams,
  signal?: AbortSignal
): Promise<CLPaginatedResponse<CLCluster> | null> {
  const courtId = params.courtId || 'nh';
  const pageSize = params.pageSize || 20;
  const orderBy = params.orderBy || '-date_filed';

  let url = `${CL_BASE}/clusters/?docket__court=${courtId}&page_size=${pageSize}&order_by=${orderBy}`;
  if (params.dateFiledAfter) url += `&date_filed__gte=${params.dateFiledAfter}`;
  if (params.dateFiledBefore) url += `&date_filed__lte=${params.dateFiledBefore}`;

  if (signal?.aborted) return null;
  return clFetch<CLPaginatedResponse<CLCluster>>(url);
}

export async function fetchClusterPage(
  nextUrl: string,
  signal?: AbortSignal
): Promise<CLPaginatedResponse<CLCluster> | null> {
  if (signal?.aborted) return null;
  await delay(REQUEST_DELAY_MS);
  return clFetch<CLPaginatedResponse<CLCluster>>(nextUrl);
}

export async function fetchOpinion(
  opinionUrl: string,
  signal?: AbortSignal
): Promise<CLOpinion | null> {
  if (signal?.aborted) return null;
  await delay(REQUEST_DELAY_MS);
  const url = opinionUrl.startsWith('http') ? opinionUrl : `${CL_SITE}${opinionUrl}`;
  return clFetch<CLOpinion>(url);
}

export async function fetchOpinionById(
  opinionId: number,
  signal?: AbortSignal
): Promise<CLOpinion | null> {
  if (signal?.aborted) return null;
  await delay(REQUEST_DELAY_MS);
  return clFetch<CLOpinion>(`${CL_BASE}/opinions/${opinionId}/`);
}

export function buildClusterUrl(cluster: CLCluster): string {
  return `${CL_SITE}${cluster.absolute_url}`;
}

export function buildOpinionFilename(cluster: CLCluster): string {
  const datePart = cluster.date_filed || 'undated';
  const namePart = (cluster.case_name || 'opinion')
    .replace(/[^a-zA-Z0-9\s.-]/g, '')
    .replace(/\s+/g, '-')
    .substring(0, 120);
  return `${datePart}_${namePart}.txt`;
}

export function extractOpinionText(opinion: CLOpinion): string {
  if (opinion.plain_text && opinion.plain_text.length > 50) {
    return opinion.plain_text;
  }
  if (opinion.html_with_citations) {
    return stripHtml(opinion.html_with_citations);
  }
  if (opinion.html) {
    return stripHtml(opinion.html);
  }
  if (opinion.html_lawbox) {
    return stripHtml(opinion.html_lawbox);
  }
  if (opinion.html_columbia) {
    return stripHtml(opinion.html_columbia);
  }
  return '';
}

function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
