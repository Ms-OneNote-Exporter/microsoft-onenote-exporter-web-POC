# Donate

This service is unofficial and free. If it saved you an afternoon, you can
support it here.

## Where the addresses come from

The addresses live in [`app/donate.config.json`](./app/donate.config.json),
**committed to the repository**. They are deliberately not read from environment
variables: an env var can be changed at deploy time without leaving a trace in
`git`, and a donation address is exactly the kind of thing where "who controls
this string today" needs an answer anyone can check. A change to this file is a
visible diff.

> The values in that file are placeholders. Replace them before deploying.

## What donations are for

Hosting. Running a headless Chromium per export is not free, and neither is the
disk the exported notebooks occupy until they are erased.

## What donations are not for

Nothing about how the service treats your data changes based on whether you
donated. There is no account, no identifier and no record linking a donation to a
session GUID.