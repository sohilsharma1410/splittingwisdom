Build and complete a responsive bill-splitting application called “SplittingWisdom”.

SplittingWisdom should help users upload bills, extract line items, assign items to group members, understand exactly how balances were calculated, and settle debts with minimal friction.

Use the existing React, TypeScript, Tailwind, Express, Drizzle, PostgreSQL, TanStack Query, Radix UI, and Lucide foundation. Preserve the current route structure and reusable components where practical, but replace hardcoded mock behavior with functional, persistent, validated workflows.

\==================================================  
1\. PRODUCT OBJECTIVE  
\==================================================

SplittingWisdom should allow users to:

\- Create and manage expense groups.  
\- Add friends, family members, roommates, or colleagues to groups.  
\- Upload receipt images.  
\- Extract bill details and line items through OCR or a clearly defined manual-review process.  
\- Review and edit extracted information.  
\- Assign individual items to one or more people.  
\- Split items equally, by percentage, by ratio, or by custom amount.  
\- Track who owes whom.  
\- Understand exactly how every balance was calculated.  
\- View expense activity and settlement history.  
\- Settle all or part of an outstanding balance.  
\- Use the application on desktop, tablet, and mobile.  
\- Switch between light and dark themes.

The product should prioritize accuracy, transparency, speed, and trust.

\==================================================  
2\. USER PAIN POINTS TO SOLVE  
\==================================================

Design SplittingWisdom around the following user problems. These should guide both product decisions and interface design.

2.1 Unclear balance calculations

Users often see that they owe a final amount without understanding how it was calculated.

SplittingWisdom should:

\- Explain every balance using related bills and line items.  
\- Show each person’s share for every item.  
\- Display tax, tip, discount, and service fee calculations separately.  
\- Make the path from receipt to final balance traceable.  
\- Provide an “How was this calculated?” view for every balance.

2.2 Manual bill splitting is slow and error-prone

Users commonly enter expenses manually, forget items, mistype prices, or calculate shares incorrectly.

SplittingWisdom should:

\- Support receipt image upload.  
\- Extract bill information where possible.  
\- Allow all extracted information to be reviewed and corrected.  
\- Preserve the original receipt for reference.  
\- Warn users when item totals do not match the bill total.  
\- Reduce repetitive data entry without hiding the calculation process.

2.3 Group expenses become disorganized

Long-running trips, households, and shared projects can accumulate many bills and members.

SplittingWisdom should:

\- Organize expenses by group.  
\- Provide searchable and filterable activity.  
\- Show group-level balances.  
\- Make it easy to identify pending and settled expenses.  
\- Keep important actions visible without overwhelming the user.

2.4 Unequal item ownership is difficult to represent

Many expenses are not simple equal splits. One person may buy a particular item, several people may share another, and some costs may be shared by everyone.

SplittingWisdom should:

\- Support item-level assignments.  
\- Support multiple people on one item.  
\- Provide equal, percentage, ratio, and custom-amount splits.  
\- Show a live preview of each person’s share.  
\- Prevent percentages from exceeding 100%.  
\- Prevent custom amounts from exceeding the item price.  
\- Clearly identify unassigned items.

2.5 Settling balances creates uncertainty

Users may be unsure how much to pay, whether a partial payment is allowed, or whether a settlement was recorded.

SplittingWisdom should:

\- Show the exact outstanding amount.  
\- Support partial settlements where appropriate.  
\- Validate settlement amounts.  
\- Show the person being paid and the direction of payment.  
\- Confirm successful settlement with visible feedback.  
\- Update all affected balances immediately.  
\- Maintain settlement history with timestamps and notes.

2.6 Users receive too much information without enough prioritization

Expense tools can become noisy when every bill, member, and notification has equal visual weight.

SplittingWisdom should:

\- Prioritize current balances and required actions.  
\- Put pending items before completed history where appropriate.  
\- Use clear sections and concise summaries.  
\- Avoid unnecessary alerts or repetitive notifications.  
\- Keep the dashboard focused on what requires attention now.

2.7 Receipt data may be inaccurate

OCR and automated extraction can misread item names, amounts, dates, or totals.

SplittingWisdom should:

\- Never treat extracted data as unquestionable.  
\- Mark uncertain values for review.  
\- Let users edit all extracted fields.  
\- Preserve the source receipt image.  
\- Display clear extraction errors.  
\- Require confirmation before finalizing a bill.

2.8 Mobile workflows can be difficult

Users often split bills at restaurants, on trips, or while standing with other people.

SplittingWisdom should:

\- Make camera and file upload easy to access.  
\- Use touch-friendly controls.  
\- Keep assignment flows usable on small screens.  
\- Use mobile bottom navigation.  
\- Use full-screen dialogs or bottom sheets on mobile.  
\- Avoid horizontal scrolling.  
\- Make important totals visible without excessive navigation.

2.9 Trust, privacy, and control matter

Users are sharing financial information and personal relationships.

SplittingWisdom should:

\- Restrict data access to authorized users.  
\- Clearly communicate what is saved.  
\- Avoid exposing private group information.  
\- Provide explicit confirmation for destructive actions.  
\- Allow users to correct mistakes.  
\- Avoid silently changing existing assignments or balances.

\==================================================  
3\. COMPETITIVE POSITIONING AND DIFFERENTIATORS  
\==================================================

SplittingWisdom should differentiate through the following product principles.

Important research caution:

The following observations about Splitwise are competitive hypotheses and positioning inputs, not permanent facts. Splitwise’s latest web and mobile builds, pricing, subscription limits, receipt-scanning capabilities, payment integrations, notifications, and user flows may change by date, country, platform, and account type. Before making any public comparison, marketing claim, feature comparison, or pricing decision, verify these details against the latest official Splitwise product experience.

Do not claim that Splitwise lacks a feature unless the latest version has been reviewed and confirmed.

3.1 Item-level transparency as the core experience

Make SplittingWisdom more than a simple expense ledger.

\- Bills should be split at the individual line-item level.  
\- Every person should be able to see which items contribute to their balance.  
\- Users should be able to trace a balance from person to bill to item.  
\- Calculations should be understandable without requiring users to perform their own math.

3.2 Receipt-to-balance workflow

Make the journey from receipt image to final balance feel continuous.

\- Upload a receipt.  
\- Review extracted data.  
\- Assign items.  
\- Preview balances.  
\- Confirm the bill.  
\- Track settlement.

Avoid forcing users to navigate through disconnected screens or repeat information.

3.3 Explainable calculations

Treat calculation transparency as a major feature.

\- Show item price.  
\- Show assigned people.  
\- Show split method.  
\- Show each person’s share.  
\- Show tax and tip allocation.  
\- Show rounding behavior.  
\- Show how settlements reduce balances.

Include clear explanatory labels instead of presenting unexplained totals.

3.4 Flexible splitting without unnecessary complexity

Support common and advanced cases while keeping the default flow simple.

\- Default to equal splitting.  
\- Offer custom percentages, ratios, and amounts when needed.  
\- Use progressive disclosure so advanced controls do not overwhelm casual users.  
\- Validate all split inputs in real time.  
\- Provide a visual calculator or preview.

3.5 Faster group setup

Reduce friction when creating a group.

\- Allow members to be added quickly.  
\- Support name-based members for casual use.  
\- Support accounts and invitations when available.  
\- Prevent duplicate members.  
\- Make group creation possible in a short focused flow.

3.6 A calmer, more focused interface

Build a clean and approachable product rather than a dense financial dashboard.

\- Keep the dashboard focused on balances and actions.  
\- Use clear hierarchy.  
\- Avoid unnecessary clutter.  
\- Use concise notifications.  
\- Make pending tasks visually distinct.  
\- Use simple language throughout the app.

3.7 Better settlement confidence

Make users confident that a payment was recorded correctly.

\- Show the exact settlement amount.  
\- Support full and partial settlement.  
\- Show a confirmation state.  
\- Update balances immediately.  
\- Preserve a settlement record.  
\- Explain what remains outstanding after a partial settlement.

3.8 Privacy-first sharing

Give users more control over what they share and with whom.

\- Keep group data private to group members.  
\- Avoid unnecessary public profiles.  
\- Make receipt images and financial details visible only to authorized users.  
\- Clearly label shared versus personal information.  
\- Do not introduce social features unless explicitly requested.

3.9 Accessible and understandable financial UI

Make the product usable for a broad range of users.

\- Do not rely on color alone for positive and negative balances.  
\- Use icons and text labels alongside colors.  
\- Support keyboard navigation.  
\- Provide clear focus states.  
\- Use accessible dialogs and form labels.  
\- Ensure currency formatting is readable.  
\- Make calculations understandable to non-technical users.

3.10 Independent, transparent product decisions

SplittingWisdom should not be defined only by comparison with another product.

\- Verify competitor assumptions before using them.  
\- Build features based on user needs rather than unsupported claims.  
\- Define SplittingWisdom’s own pricing and feature boundaries independently.  
\- Do not promise that features are unlimited or free unless that has been explicitly decided.  
\- Do not copy proprietary branding, layouts, or wording.

\==================================================  
4\. APPLICATION SHELL AND NAVIGATION  
\==================================================

Desktop navigation:

\- Use a left sidebar or top navigation area.  
\- Show the SplittingWisdom logo and brand name.  
\- Include a supporting tagline such as “Split fairly. Understand everything.”  
\- Navigation items:  
  \- Dashboard  
  \- Groups  
  \- Activity  
  \- Balances  
\- Provide a prominent “Upload Bill” or “New Bill” action.  
\- Include a user account area.  
\- Include a light/dark theme toggle.  
\- Support sidebar collapse and expansion.

Mobile navigation:

\- Use a fixed or sticky bottom tab bar.  
\- Include:  
  \- Home  
  \- Groups  
  \- Activity  
  \- Balances  
\- Provide a floating action button for uploading a bill.  
\- Ensure the bottom bar does not cover page content.  
\- Use clear active states.

Routes:

\- \`/\`  
  \- Dashboard  
\- \`/groups\`  
  \- Groups list  
\- \`/group/:id\`  
  \- Group detail  
\- \`/activity\`  
  \- Expense history  
\- \`/balances\`  
  \- All balances  
\- \`/balance/:id\`  
  \- Person-to-person balance detail  
\- \`/bill/:id\`  
  \- Bill detail and assignment  
\- Not-found route

Navigation should work without full page reloads.

\==================================================  
5\. AUTHENTICATION AND ACCOUNT  
\==================================================

Implement basic session-based authentication using the existing users foundation.

Required functionality:

\- Registration.  
\- Login.  
\- Logout.  
\- Session persistence.  
\- Current-user lookup.  
\- Protected application routes.  
\- Secure password storage.  
\- Invalid credential handling.  
\- Empty account state for new users.

The account area should show:

\- Username or display name.  
\- Email if supported.  
\- Avatar or initials.  
\- Account settings entry point.  
\- Logout action.

Do not add role-based access control unless requested later.

\==================================================  
6\. ONBOARDING AND EMPTY STATES  
\==================================================

Provide an onboarding experience explaining:

1\. Upload a bill.  
2\. Assign items.  
3\. Track and settle balances.

Include:

\- Friendly illustrations.  
\- “Upload your first bill” CTA.  
\- “Create a group” secondary CTA.  
\- Helpful empty states for groups, bills, activity, balances, settlements, and assignments.

Each empty state should contain:

\- Heading.  
\- Short explanation.  
\- Relevant icon or illustration.  
\- Primary action.

\==================================================  
7\. DASHBOARD  
\==================================================

Create a dashboard with:

Header:

\- Title: “Dashboard”.  
\- Supporting text such as “See what’s owed, what you owe, and what needs attention.”  
\- Primary upload/new bill action.

Summary cards:

1\. Net balance  
   \- Display the user’s current net amount.  
   \- Show whether the user is owed money or owes money.  
   \- Link to Balances.

2\. Active groups  
   \- Display group count.  
   \- Link to Groups.

3\. Recent bills  
   \- Display recent expense count.  
   \- Link to Activity.

Recent activity:

\- Show recent bills.  
\- Include receipt thumbnail, description, group, date, total, item count, payer, and status.  
\- Clicking a bill opens Bill Detail.  
\- Include “View all”.

Outstanding balances:

\- Show people who owe the current user.  
\- Show people the current user owes.  
\- Include avatar, name, direction, amount, and settlement action.  
\- Prevent Settle clicks from triggering row navigation.

\==================================================  
8\. GROUP MANAGEMENT  
\==================================================

Groups list:

\- Page title: “Groups”.  
\- Supporting description.  
\- “Create Group” button.  
\- Responsive group-card grid.

Group cards should show:

\- Group name.  
\- Optional cover image.  
\- Avatar stack.  
\- Member count.  
\- Bill count.  
\- Current user’s group balance.  
\- Positive, negative, or settled status.  
\- Last activity date.  
\- Settings menu.

Create group flow:

\- Group name input.  
\- Member input.  
\- Add member button.  
\- Enter-to-add behavior.  
\- Duplicate prevention.  
\- Removable member chips.  
\- Validation.  
\- Success feedback.  
\- Persistent creation.  
\- Navigation to the new group.

Group detail:

\- Group name and metadata.  
\- Optional group cover.  
\- Member count and bill count.  
\- Add member.  
\- Group settings.  
\- Member grid with avatars, names, and balances.  
\- Group bill list.  
\- Group balance summary.

\==================================================  
9\. BILL UPLOAD AND RECEIPT PROCESSING  
\==================================================

Provide bill upload from:

\- Sidebar.  
\- Dashboard.  
\- Mobile floating action button.

Upload interface:

\- Desktop centered modal.  
\- Mobile full-screen modal or bottom sheet.  
\- Image upload and camera/file picker.  
\- File validation.  
\- Receipt preview.  
\- Selected filename.  
\- Cancel and Process Bill actions.  
\- Processing spinner.  
\- Upload and processing error handling.

Extract where possible:

\- Merchant.  
\- Description.  
\- Date.  
\- Total.  
\- Line items.  
\- Prices.  
\- Quantity.  
\- Tax.  
\- Tip.  
\- Service fees.  
\- Discounts.  
\- Payer.

OCR requirements:

\- Show skeleton/loading states.  
\- Mark uncertain values.  
\- Allow correction of all extracted fields.  
\- Preserve original receipt.  
\- Do not silently fail.

Review screen:

\- Receipt preview.  
\- Editable bill details.  
\- Editable item list.  
\- Add, edit, and remove items.  
\- Tax, tip, discount, and fee controls.  
\- Group selector.  
\- Payer selector.  
\- Total mismatch warning.  
\- Confirm and save action.

\==================================================  
10\. BILL DETAIL AND ITEM ASSIGNMENT  
\==================================================

Bill detail should show:

\- Description.  
\- Receipt preview.  
\- Date.  
\- Group.  
\- Payer.  
\- Total.  
\- Tax/tip/fee breakdown.  
\- Pending or settled status.  
\- Share action if supported.  
\- Assignment progress.

Each item row should show:

\- Item name.  
\- Price.  
\- Quantity if available.  
\- Assigned members.  
\- Per-person share.  
\- Assignment status.  
\- Edit action.  
\- Remove assignment action.

Assignment interface:

\- Display group members.  
\- Support multi-select.  
\- Use avatars, names, and color-coded chips.  
\- Default to equal splitting.  
\- Support percentages, ratios, and custom amounts.  
\- Show live per-person calculations.  
\- Validate all values.  
\- Ensure percentages equal 100%.  
\- Ensure custom amounts equal the item price.  
\- Highlight unassigned items.  
\- Allow save or cancel.

Finalization:

\- Save all assignments.  
\- Recalculate balances server-side.  
\- Show assignment completion progress.  
\- Warn about unassigned items.  
\- Mark the bill pending until required review is complete.  
\- Allow settlement after payment records exist.

\==================================================  
11\. ACTIVITY AND EXPENSE HISTORY  
\==================================================

Activity page:

\- Timeline or grouped date layout.  
\- Filters:  
  \- All  
  \- Pending  
  \- Settled  
\- Display counts for filters.

Bill cards should show:

\- Receipt thumbnail.  
\- Description.  
\- Group.  
\- Date.  
\- Total.  
\- Item count.  
\- Payer.  
\- Current user’s share.  
\- Status.

Expandable details should show:

\- Itemized breakdown.  
\- People assigned to each item.  
\- Contribution percentages.  
\- Horizontal progress bars.  
\- Settlement details where applicable.

Include loading, empty, error, and retry states.

\==================================================  
12\. BALANCES  
\==================================================

Balances page should show:

\- Net balance.  
\- Total owed to the user.  
\- Total the user owes.  
\- Number of unsettled balances.

Filters:

\- All.  
\- Owed to You.  
\- You Owe.

Balance cards:

\- Avatar or initials.  
\- Person name.  
\- “owes you” or “you owe”.  
\- Amount.  
\- Last related activity.  
\- Settle button where appropriate.  
\- Navigation to balance detail.

Balance detail:

\- Person identity.  
\- Current outstanding amount.  
\- Explanation of calculation.  
\- Related bills.  
\- Item-level contribution details.  
\- Settlement history.  
\- Full or partial Settle Up action.

Optional balance-flow visualization:

\- Person nodes.  
\- Connecting lines/arrows.  
\- Amount labels.  
\- Keep the diagram secondary to the numerical summary.

\==================================================  
13\. SETTLEMENTS  
\==================================================

Settlement dialog:

\- Person being settled with.  
\- Outstanding amount.  
\- Editable currency amount.  
\- Optional note.  
\- Optional settlement date.  
\- Cancel and Confirm actions.

Validation:

\- Amount must be greater than zero.  
\- Amount must not exceed the outstanding balance unless overpayment is intentionally supported.  
\- Prevent duplicate submissions.  
\- Handle currency accurately.

After settlement:

\- Save the settlement.  
\- Recalculate balances.  
\- Update dashboard, activity, groups, and balance pages.  
\- Show a single animated success checkmark.  
\- Provide Done or automatic close behavior.

Settlement history:

\- Person.  
\- Amount.  
\- Date/time.  
\- Note.  
\- Checkmark status.  
\- Expandable details.

\==================================================  
14\. DATA MODEL AND BACKEND  
\==================================================

Replace mock data with persistent database-backed data.

Required entities:

Users:

\- id  
\- username/display name  
\- email if supported  
\- password hash  
\- created timestamp

Groups:

\- id  
\- name  
\- cover image  
\- created by  
\- created timestamp  
\- updated timestamp

Group members:

\- id  
\- group id  
\- user id or member name/email  
\- joined timestamp

Bills:

\- id  
\- group id  
\- description  
\- merchant  
\- date  
\- total amount  
\- tax  
\- tip  
\- service fee  
\- discount  
\- paid-by user  
\- receipt image  
\- status  
\- created timestamp  
\- updated timestamp

Bill items:

\- id  
\- bill id  
\- name  
\- price  
\- quantity  
\- sort order

Item assignments:

\- id  
\- bill item id  
\- member id  
\- split type  
\- percentage  
\- ratio  
\- custom amount

Settlements:

\- id  
\- group id  
\- payer  
\- recipient  
\- amount  
\- note  
\- settlement date  
\- created timestamp

Use:

\- \`/api\` route prefixes.  
\- Zod validation.  
\- Consistent JSON responses.  
\- Proper HTTP status codes.  
\- Protected user-specific access.  
\- Server-side balance calculations.  
\- Explicit database and network error handling.  
\- TanStack Query for fetching, caching, invalidation, and mutations.

Suggested endpoints:

\- \`POST /api/auth/register\`  
\- \`POST /api/auth/login\`  
\- \`POST /api/auth/logout\`  
\- \`GET /api/auth/me\`  
\- \`GET /api/groups\`  
\- \`POST /api/groups\`  
\- \`GET /api/groups/:id\`  
\- \`PATCH /api/groups/:id\`  
\- \`DELETE /api/groups/:id\`  
\- \`POST /api/groups/:id/members\`  
\- \`DELETE /api/groups/:id/members/:memberId\`  
\- \`GET /api/groups/:id/bills\`  
\- \`POST /api/bills\`  
\- \`GET /api/bills/:id\`  
\- \`PATCH /api/bills/:id\`  
\- \`DELETE /api/bills/:id\`  
\- \`POST /api/bills/:id/items\`  
\- \`PATCH /api/bill-items/:id\`  
\- \`DELETE /api/bill-items/:id\`  
\- \`POST /api/bill-items/:id/assignments\`  
\- \`GET /api/balances\`  
\- \`GET /api/balances/:personId\`  
\- \`POST /api/settlements\`  
\- \`GET /api/settlements\`

\==================================================  
15\. VISUAL DESIGN SYSTEM  
\==================================================

Use a friendly, trustworthy, polished visual style.

Light mode:

\- Primary mint: \#5BC5A7.  
\- Secondary coral: \#FF6B6B.  
\- Background: \#F8F9FA.  
\- Surface: \#FFFFFF.  
\- Primary text: \#2C3E50.  
\- Secondary text: muted gray.  
\- Accent teal: \#4ECDC4.  
\- Success green: \#27AE60.

Dark mode:

\- Dark slate background.  
\- Elevated dark surface cards.  
\- Lighter mint and softer coral.  
\- High-contrast text.  
\- Same semantic color meaning between modes.

Typography:

\- Inter for UI controls and headings.  
\- Roboto for body and transaction details.  
\- Roboto Mono or tabular numerals for currency.  
\- Hero headings around 36px.  
\- Section headings around 24px.  
\- Card headings around 18px.  
\- Body text around 16px.  
\- Metadata around 14px.

Cards:

\- Rounded-xl corners.  
\- Subtle borders.  
\- Moderate shadows.  
\- 16px–24px padding.  
\- Subtle lift on hover.  
\- Avoid unnecessary visual clutter.

Buttons:

\- Mint primary buttons.  
\- Coral settlement/debt actions.  
\- Mint outline buttons.  
\- Rounded-lg corners.  
\- Clear icons and labels.  
\- 56px circular FAB where appropriate.

Forms:

\- Rounded-lg inputs.  
\- Visible mint focus states.  
\- Right-aligned currency input with \`$\` prefix.  
\- Calendar popovers.  
\- Mint active states for toggles and checkboxes.

\==================================================  
16\. RESPONSIVE BEHAVIOR  
\==================================================

Mobile:

\- 16px horizontal padding.  
\- One-column layouts.  
\- Bottom navigation.  
\- Floating upload action.  
\- Full-screen upload and assignment dialogs.  
\- Touch-friendly controls.  
\- No horizontal scrolling.  
\- Always-visible important totals.

Tablet:

\- Two-column layouts where useful.  
\- Collapsible navigation.  
\- Readable card widths.

Desktop:

\- Sidebar or top navigation.  
\- Maximum content width around 1152px.  
\- Two-column dashboard sections.  
\- Receipt preview beside extracted data.  
\- Centered modal cards.  
\- Primary actions near the top-right.

\==================================================  
17\. LOADING, ERROR, AND SUCCESS STATES  
\==================================================

Implement clear states for every asynchronous operation.

Loading:

\- Skeleton cards.  
\- Skeleton receipt items.  
\- Spinners.  
\- Disabled duplicate-submit buttons.

Errors:

\- Upload failure.  
\- OCR failure.  
\- Invalid form.  
\- Network failure.  
\- Database failure.  
\- Unauthorized access.  
\- Missing group or bill.  
\- Retry action.

Empty states:

\- No groups.  
\- No bills.  
\- No activity.  
\- No balances.  
\- No settlements.  
\- No assigned people.  
\- No receipt.

Success states:

\- Group created.  
\- Member added.  
\- Bill uploaded.  
\- Bill processed.  
\- Assignment saved.  
\- Settlement completed.

No important action should only log to the console.

\==================================================  
18\. ACCESSIBILITY AND UX  
\==================================================

\- Use semantic HTML.  
\- Label every input.  
\- Support keyboard navigation.  
\- Support Enter and Escape in dialogs.  
\- Use accessible dialog titles and descriptions.  
\- Provide visible focus states.  
\- Maintain sufficient contrast.  
\- Do not rely on color alone.  
\- Include icons and text labels.  
\- Add aria-labels to icon-only buttons.  
\- Make mobile touch targets large enough.  
\- Trap focus inside dialogs.  
\- Announce important status changes to assistive technology.

\==================================================  
19\. ANIMATION AND MOTION  
\==================================================

Use restrained motion:

\- Subtle FAB scale on hover.  
\- Small card lift on hover.  
\- Simple fade-in for page content.  
\- Slide-up dialogs on mobile.  
\- Fade/scale dialogs on desktop.  
\- Single checkmark animation after settlement.  
\- Skeleton shimmer or spinners during loading.

Avoid excessive or distracting animation.

\==================================================  
20\. RESEARCH AND COMPETITOR VERIFICATION NOTE  
\==================================================

Before finalizing product positioning or writing marketing copy about Splitwise:

\- Review the latest official Splitwise web and mobile builds.  
\- Verify current pricing and subscription restrictions.  
\- Verify which receipt, OCR, split, payment, notification, export, and group features are currently available.  
\- Verify differences by region and platform.  
\- Verify whether any proposed SplittingWisdom differentiator already exists in Splitwise.  
\- Treat all competitive observations as hypotheses until confirmed.  
\- Do not use unsupported claims such as “Splitwise does not support X”.  
\- Do not copy Splitwise’s branding, proprietary wording, or exact visual design.  
\- Use the comparison only to identify user needs and opportunities for a clearer experience.

\==================================================  
21\. SCOPE BOUNDARIES  
\==================================================

Initial scope includes:

\- User accounts.  
\- Groups and members.  
\- Receipt upload.  
\- Receipt review and OCR/extraction.  
\- Bills and bill items.  
\- Item-level assignment.  
\- Equal and custom splitting.  
\- Activity history.  
\- Balance calculation.  
\- Settlement tracking.  
\- Light/dark mode.  
\- Responsive desktop, tablet, and mobile layouts.  
\- Persistent database-backed data.

Do not add the following unless explicitly requested:

\- Bank account integrations.  
\- Real payment processing.  
\- Automatic bank transfers.  
\- Multi-currency conversion.  
\- Enterprise permissions.  
\- Advanced accounting.  
\- Public social feeds.  
\- Public profiles.  
\- Chat or messaging.  
\- Subscription billing.  
\- Native mobile applications.  
\- Complex administrator dashboards.  
\- Advanced financial analytics.

\==================================================  
22\. ACCEPTANCE CRITERIA  
\==================================================

The application is complete when:

\- A user can register, log in, and access only authorized data.  
\- A user can create a group and add members.  
\- A user can upload a receipt.  
\- The application shows a processing state.  
\- Extracted bill details can be reviewed and edited.  
\- A user can add, edit, and remove bill items.  
\- A user can assign each item to one or more people.  
\- Equal and custom split calculations are accurate.  
\- The user can understand how every balance was calculated.  
\- Group balances are recalculated correctly.  
\- Dashboard summaries use live data.  
\- Activity filters work.  
\- Balance filters work.  
\- Bill detail pages show item-level breakdowns.  
\- A user can view a person-to-person balance detail page.  
\- A user can settle all or part of an outstanding balance.  
\- Settlement records update all affected screens.  
\- Pending and settled statuses are accurate.  
\- Loading, error, empty, and success states are implemented.  
\- Light and dark themes work and persist.  
\- Desktop, tablet, and mobile layouts are usable.  
\- Important actions provide visible feedback.  
\- No core action is implemented only as a console log.  
\- Mock data is replaced with persistent application data.  
\- TypeScript checks pass.  
\- The production build completes successfully.

