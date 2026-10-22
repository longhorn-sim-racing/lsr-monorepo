# Admin Quick Reference

Fast answers for common admin tasks.

## Events

| Task | Steps |
|------|-------|
| Create event | Admin > Events > New Event > Fill form > Publish |
| Edit event | Admin > Events > Click edit icon on event row |
| Cancel event | Admin > Events > Click status icon > Set to Cancelled |
| View registrations | Admin > Events > Click settings icon > Registration tab |
| Get QR code | Admin > Events > Click settings icon > Attendance tab > QR Code section |
| Manual check-in | Attendance tab > "Add Attendee" button > Search member |
| Promote from waitlist | Registration tab > Waitlist section > Click promote icon |

## Jack decks and graphics

| Task | Steps |
|------|-------|
| Make slides or a graphic | Admin > Jack > a room > ask, e.g. "a 5-slide deck for GM 2" |
| See or download a deck | The deck card's Open button, or Admin > Decks and graphics |
| Change a deck | Ask Jack in the same room |
| Undo a change | The deck's page > Versions > Restore |

## Results

| Task | Steps |
|------|-------|
| Upload results | Admin > Results > Upload button > Select JSON file |
| Process results | Click result row > Assign event > Select points > Parse > Ingest |
| Fix bad results | Click result row > Force Delete > Re-upload correct file |
| Recalc standings | Admin > Seasons > Force Recompute Standings |

## Quick Setup Templates

### Social Event (no tracking)
```
- Title, times, venue
- Registration: ON, no capacity
- Check-in: OFF
- Publish
```

### Competition Event (full tracking)
```
- Title, times, venue
- Registration: ON, set capacity, waitlist ON
- Check-in: ON, window = event times
- Publish
- After event: Upload + ingest results
```

### Practice/Casual Race
```
- Title, times, venue
- Registration: ON, no capacity
- Check-in: ON
- Publish
```

## Status Quick Guide

| Event Status | Visible? | Editable? |
|--------------|----------|-----------|
| Draft | No | Yes |
| Scheduled | No (until scheduled time) | Yes |
| Published | Yes | Yes |
| In Progress | Yes (automatic) | Yes |
| Completed | Yes (automatic) | Yes |
| Cancelled | Yes (shows cancelled) | Yes |

## Keyboard Shortcuts

- None currently—all actions are button/click based

## Need Help?

- Full documentation: `docs/admin-guide.md`
- Technical issues: Contact the web team
