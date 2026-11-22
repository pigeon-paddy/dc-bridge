# Discord Webhook Bridge

This app forwards messages from a selected channel in discord to a webhook and formats them accordingly.

### Disclaimer
If multiple instances listen on the same Discord channel, the same message will be forwarded by every instance.
If these instances forward to the same webhook, the same message will reach the webhook multiple times.