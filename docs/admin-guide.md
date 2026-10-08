# LSR Admin Guide

A guide for officers to manage the Longhorn Sim Racing website.

## Getting Started

Access the admin panel at `/admin` on the website. You must be logged in with an officer or admin account.

---

## Events

### Creating an Event

1. Go to **Admin > Events** and click **New Event**
2. Fill in the required fields:
   - **Title**: The event name members will see
   - **Slug**: URL-friendly version (auto-generated from title, but editable)
   - **Timezone**: Set this first—it affects how times display to members
   - **Starts At / Ends At**: When the event takes place

3. Optional settings:
   - **Series**: Group related events together
   - **Venue**: Where the event is held
   - **Summary**: Brief description shown in event listings
   - **Hero Image**: Featured image for the event page

4. Choose a publication option:
   - **Save as Draft**: Keep hidden while you work on it
   - **Schedule**: Set a future date/time to automatically publish
   - **Publish Now**: Make it visible immediately

### Event Status Explained

| Status | Meaning |
|--------|---------|
| Draft | Hidden from public, only visible to admins |
| Published | Visible to everyone |
| Scheduled | Will automatically publish at the scheduled time |
| In Progress | Event is happening now (automatic based on times) |
| Completed | Event has ended (automatic based on times) |
| Cancelled | Event will not happen |
| Postponed | Event delayed to a future date |

### Managing Registration

Enable registration to let members sign up for events.

1. In the event editor, toggle **Enable Registration**
2. Set the registration window:
   - **Opens At**: When signups become available
   - **Closes At**: When signups end
3. Optional capacity settings:
   - **Capacity Limit**: Maximum number of participants (leave empty for unlimited)
   - **Enable Waitlist**: If capacity is reached, additional signups join a queue

**Waitlist behavior:**
- When a spot opens (someone drops out, you raise the capacity or remove the fee), the first person on the waitlist is automatically promoted
- To promote by hand instead, turn off **Automatically move people up from the waitlist** on the event's **Manage → Registration** tab. Paid events never auto-promote, since waitlisted people haven't paid yet
- While anyone is waiting, new signups join the end of the waitlist instead of taking a freed spot
- You can manually reorder the waitlist by dragging names
- You can manually promote someone from the waitlist

### Managing Check-in

Use check-in to track who actually attended an event.

1. Toggle **Enable Check-in** in the event settings
2. Set the check-in window (typically event start to end time)
3. On the event management page, go to the **Attendance** tab
4. Display or download the **QR code** for members to scan

**Check-in methods:**
- **QR Scan**: Members scan the code with their phone
- **Manual**: Use the "Add Attendee" button to check someone in manually

**Attendance tabs:**
- **Checked In**: Members who scanned or were manually added
- **Missing**: Registered but haven't checked in yet
- **Walk-ins**: Checked in but weren't registered

---

## Seasons & Competition

### Hierarchy

```
Series (e.g., "Pro Championship")
  └── Season (e.g., "Spring 2026")
        └── Events/Races (individual competitions)
```

### Creating a Season

1. Go to **Admin > Seasons** and click **New Season**
2. Fill in:
   - **Name**: Season title (e.g., "LSR GT3 Season 1")
   - **Year**: Calendar year
   - **Series**: Which series this season belongs to
   - **Start/End Date**: When the season runs
   - **Default Points Ruleset**: Saved with the season for reference. Points are actually awarded by the ruleset you pick when you ingest each results upload (see below)

### Importing Race Results

1. Go to **Admin > Results**
2. Click **Upload** and select your JSON results file
3. The system will parse the file and show a preview
4. Assign the results to an event
5. Select the points ruleset for this upload. This is what awards points:
   - **F1**: Standard F1 points (25, 18, 15, 12, 10, 8, 6, 4, 2, 1)
   - **Half Points**: 50% of F1 values
   - **None**: No points (practice and qualifying sessions never award points)
6. Click **Ingest** to process the results

Once ingested, standings are automatically calculated.

**If you need to fix results:**
- Use **Force Delete (Un-Ingest)** to remove bad data
- Re-upload the corrected file

### Recalculating Standings

If standings look wrong after corrections:
1. Go to **Admin > Seasons**
2. Find the season and click **Force Recompute Standings**

This recalculates all points from ingested results.

---

## Driver & Car Mappings

### Driver Mappings

Race results identify drivers by a GUID (unique ID from the racing sim). Driver mappings link these GUIDs to LSR member accounts.

**To map a driver:**
1. Go to **Admin > Drivers**
2. Find the unmapped driver (shown as "Unmapped")
3. Click the mapping button
4. Search for and select the LSR member

**Why this matters:** Mapped drivers appear in member profiles and season standings correctly.

### Car Mappings

Race exports use internal car names that may not be user-friendly. Car mappings translate these to display names.

**To map a car:**
1. Go to **Admin > Cars**
2. Check the **Unmapped** section for cars needing attention
3. Click to create a mapping with a friendly display name

---

## Series & Venues

### Managing Series

Series group related events (e.g., "Social Events", "Pro Championship").

1. Go to **Admin > Series**
2. Create series with a title and URL slug
3. When creating events or seasons, select the appropriate series

### Managing Venues

Venues are locations where events take place.

1. Go to **Admin > Venues**
2. Add venue details:
   - Name, address, city, state, etc.
   - Optionally add coordinates for map display
3. When creating events, select the venue

---

## News & Gallery

### Publishing News

1. Go to **Admin > News**
2. Click **New Post**
3. Write your content (supports formatting)
4. Add tags for categorization
5. Publish, schedule, or save as draft

### Managing the Gallery

1. Go to **Admin > Gallery**
2. Upload images (they're hosted on Cloudinary)
3. Add alt text and photographer credit
4. Drag images to reorder them

---

## Audit Log

The main admin dashboard shows an activity log of all admin actions. Use this to:
- See who made changes and when
- Review what was changed (before/after data)
- Search by user, action type, or keywords

---

## Tips & Common Tasks

### Quick event setup for a social
1. Create event with title, times, venue
2. Enable registration with no capacity limit
3. Disable check-in (optional for casual events)
4. Publish immediately

### Quick event setup for a competition
1. Create event with title, times, venue
2. Enable registration with appropriate capacity
3. Enable waitlist if you expect overflow
4. Enable check-in for attendance tracking
5. After the event, upload and ingest results

### Fixing mistakes
- **Wrong event times**: Edit the event and update the times
- **Wrong registration settings**: Edit anytime before/during registration
- **Bad race results**: Un-ingest, delete upload, re-upload correct file
- **Wrong standings**: Force recompute after fixing results

---

## Glossary

| Term | Definition |
|------|------------|
| Slug | URL-friendly version of a name (lowercase, hyphens) |
| GUID | Unique identifier from the racing simulation |
| Ingest | Process of officially recording imported data |
| Waitlist | Queue for overflow signups when at capacity |
| Series | Grouping of related events |
| Season | Competitive period with standings and points |
