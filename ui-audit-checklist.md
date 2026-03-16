# UI/UX Audit Checklist

## Layout & Structure
- [x] 1. Add favicon
- [x] 2. Better page title (product name)
- [ ] 3. Add loading state on initial page load
- [ ] 4. Settings panel covers chat — consider resize/dock
- [ ] 5. Sidebar agent list needs visible scroll indicator for overflow
- [ ] 6. Mobile: add hamburger menu instead of hiding sidebar entirely

## Setup Flow
- [ ] 7. Add visual branding (logo or styled product name) to setup card
- [ ] 8. Add "show password" toggle on API key input
- [ ] 9. API key format validation while typing
- [x] 10. Enter key should submit setup form

## Chat Area
- [x] 11. Add typing/thinking indicator after sending a message
- [x] 12. System messages should use renderMarkdown (not escapeHtml)
- [ ] 13. Group consecutive messages from same agent (no redundant headers)
- [ ] 14. Add way to clear chat
- [x] 15. Center message container on ultrawide screens
- [x] 16. Add keyboard shortcut hint on send button tooltip
- [x] 17. Multi-line input (textarea instead of single-line input)
- [ ] 18. Add empty state graphic/icon
- [ ] 19. Loading state on approve/reject buttons (spinner)

## Sidebar
- [ ] 20. Search/filter for agents (useful with 50+ imported)
- [x] 21. Show enabled/disabled state on agent list items
- [ ] 22. Close add-project form on outside click
- [x] 23. Connection status as subtle dot instead of permanent text
- [x] 24. Show counts in section headings: Agents (10), Projects (3)

## Settings Panel
- [ ] 25. Confirmation on destructive actions (delete knowledge, remove project)
- [ ] 26. Allow editing knowledge entries (not just add/delete)
- [ ] 27. Visual confirmation on heartbeat save (brief "Saved" flash)
- [ ] 28. Search/filter in import agent list
- [ ] 29. Larger close button for touch devices
- [x] 30. Keyboard shortcut to open/close settings

## Accessibility
- [ ] 31. ARIA labels on interactive elements
- [ ] 32. Non-color status indicators (icons alongside colors)
- [ ] 33. Focus management (settings open/close)
- [ ] 34. Fix tab order for settings panel
- [x] 35. role="log" and aria-live on message list
- [ ] 36. Label association on toggle switches

## Performance
- [ ] 37. Split JS or defer non-critical code
- [ ] 38. Lazy load settings/history
- [x] 39. WebSocket reconnect with exponential backoff
- [ ] 40. Virtualize or limit DOM messages for large histories

## Missing Features
- [x] 41. Agent thinking indicator (critical)
- [ ] 42. Notification sound on agent response
- [ ] 43. @mention specific agent
- [ ] 44. Message search
- [ ] 45. Copy message button
- [ ] 46. Dark/light theme toggle
- [ ] 47. User avatar/identity customization
