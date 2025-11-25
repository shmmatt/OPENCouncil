# OPENCouncil Design Guidelines

## Design Approach & References

**Selected Approach:** Hybrid Design System combining productivity-focused patterns with familiar chat interfaces

**Primary References:**
- **ChatGPT** for chat interface patterns (sidebar, message bubbles, input handling)
- **Linear** for typography hierarchy and clean aesthetics
- **Fluent Design** for admin panel and data tables
- **Notion** for document management UI patterns

**Core Design Principles:**
1. Professional trustworthiness for municipal government context
2. Extreme clarity and readability for varied user technical proficiency
3. Efficiency-first workflows minimizing clicks
4. Familiar patterns requiring zero learning curve
5. Accessibility as baseline requirement

## Typography System

**Font Stack:**
- Primary: Inter (via Google Fonts CDN)
- Monospace: JetBrains Mono (for code/file names)

**Hierarchy:**
- Page Titles: text-2xl, font-semibold (admin pages)
- Section Headers: text-lg, font-medium
- Body Text: text-base, font-normal
- Labels: text-sm, font-medium
- Metadata/Timestamps: text-xs, font-normal
- Chat Messages: text-base with user messages at font-normal, assistant at font-normal
- Document Names: text-sm, font-medium

## Layout & Spacing System

**Tailwind Spacing Primitives:** Use 2, 4, 6, 8, 12, 16, 20 as core units
- Component padding: p-4 to p-6
- Section gaps: gap-4 to gap-8
- Container margins: m-4 to m-8
- Icon spacing: space-x-2 to space-x-3

**Grid Structure:**
- Chat Layout: Fixed left sidebar (w-64 to w-72) + flex-1 main content
- Admin Tables: Full-width with max-w-7xl container, px-6
- Forms: max-w-2xl centered containers

**Vertical Rhythm:**
- Consistent spacing between sections: space-y-6
- Form field groups: space-y-4
- List items: space-y-2

## Component Library

### Navigation & Layout

**Admin Navigation:**
- Top bar with app logo/title, admin user indicator, logout button
- Horizontal layout with h-16 height
- Logo left-aligned, actions right-aligned with space-x-4

**Chat Sidebar:**
- Full height (h-screen) with sticky positioning
- "New Chat" button prominently at top (w-full, mb-4)
- Session list below with hover states
- Active session clearly distinguished with background treatment
- Each session shows truncated title + timestamp
- Scrollable session list (overflow-y-auto)

**Main Chat Area:**
- Header with session title (truncated with ellipsis)
- Scrollable message container (flex-1, overflow-y-auto)
- Fixed input area at bottom (sticky positioning)

### Forms & Inputs

**Admin Login:**
- Centered card (max-w-md) with simple email + password fields
- Vertical field stacking with space-y-4
- Full-width submit button
- Clear error messaging below submit button

**Document Upload Form:**
- File input with drag-and-drop zone styling
- Metadata fields in 2-column grid (grid-cols-2 gap-4) on desktop, single column mobile
- Tags/metadata: category dropdown, town text input, board text input, year number input, notes textarea
- Submit button full-width below form
- Upload progress indicator when processing

**Chat Input:**
- Auto-expanding textarea with min-height
- Send button adjacent to input (right side) or below on mobile
- Placeholder: "Ask about your municipal documents..."
- Subtle hint: "Press Enter to send, Shift+Enter for new line"

### Data Display

**Document Table:**
- Clean table with headers: Filename, Category, Town, Board, Year, Uploaded, Actions
- Row hover states for interactivity
- Action column: Delete icon button with confirmation modal
- Alternating subtle row backgrounds
- Responsive: Stack to cards on mobile (< md breakpoint)
- Empty state: "No documents uploaded yet" with upload prompt

**Chat Messages:**
- User messages: Right-aligned with max-w-3xl
- Assistant messages: Left-aligned with max-w-3xl
- Message bubbles with rounded-lg corners
- Avatar indicators: User (generic icon), Assistant (logo/icon)
- Timestamp below each message (text-xs)
- Citations as small linked references below assistant messages when present
- Loading state: Animated typing indicator for assistant
- Spacing between messages: space-y-6

**Session List Items:**
- Compact layout with title + timestamp stacked
- Truncate title with text-ellipsis
- Hover/active states clearly visible
- Recently active sessions appear first
- Border between items for visual separation

### Modals & Overlays

**Delete Confirmation:**
- Centered modal (max-w-md)
- Clear heading: "Delete Document?"
- Document name displayed
- Warning text about permanent deletion
- Action buttons: Cancel (secondary) + Delete (destructive/danger styling)
- Buttons side-by-side with gap-3

**Typing Indicator:**
- Three animated dots in assistant message position
- Subtle pulse animation
- Same styling as assistant message bubble

### Buttons & Actions

**Primary Actions:** Full-width on mobile, auto-width on desktop with px-8
**Secondary Actions:** Outlined style with matching padding
**Icon Buttons:** Square aspect ratio (w-10 h-10) with centered icon
**Destructive Actions:** Clear visual distinction (for delete operations)

### State Indicators

**Loading States:**
- Spinner for document uploads
- Skeleton screens for chat history loading
- Typing indicator for AI responses

**Empty States:**
- Centered with icon + message + action button
- Chat: "Start a new conversation to ask questions"
- Documents: "Upload your first document to get started"

**Error States:**
- Inline error messages below relevant inputs (text-sm, text-red-600)
- Toast notifications for async operations

## Icons & Assets

**Icon Library:** Heroicons (via CDN)
- Document icon for file references
- Chat bubble icon for sessions
- Upload icon for file upload
- Trash icon for delete actions
- User icon for avatars
- Plus icon for "New Chat"
- Search icon for future search features

**Images:** None required for v1 - purely functional UI

## Accessibility Standards

- All interactive elements meet 44x44px minimum touch target
- Form labels properly associated with inputs
- Skip links for keyboard navigation
- Focus indicators on all interactive elements (ring-2 ring-offset-2)
- ARIA labels for icon-only buttons
- Semantic HTML throughout (nav, main, article for messages, etc.)
- Color-independent state indicators (icons + text, not just color)
- Consistent tab order throughout application

## Responsive Behavior

**Breakpoints:**
- Mobile-first approach
- Sidebar collapses to drawer on mobile (< md)
- Tables convert to stacked cards on mobile
- Two-column forms become single column on mobile
- Chat input stacks send button below textarea on mobile

**Mobile Optimizations:**
- Larger touch targets (min-h-12 for buttons)
- Full-width buttons on mobile
- Drawer/hamburger for chat session list
- Sticky headers for context retention