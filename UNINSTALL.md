# Uninstall ORNELYON

ORNELYON does not install anything globally, does not change system settings, and does not register services or startup items. Removing it is a matter of deleting its folder.

1. Stop ORNELYON: press Ctrl+C in the terminal window where it is running.
2. Delete the folder you unzipped (for example `ORNELYON-0.4.1`).
   - Your settings and run history are stored in the `data` folder inside it. Deleting the folder removes them too. To keep them, copy `data` somewhere safe first.
3. Optional: if you also want to sign out of the official agent tools, use their own commands:
   - `codex logout`
   - `claude auth logout`

ORNELYON itself never stores API keys or sign-in tokens. Those stay with the official tools.
