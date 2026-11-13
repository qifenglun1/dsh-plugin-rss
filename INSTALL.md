# Installing the DSH RSS reader

This bundle installs into a DSH profile and adds an **RSS** panel to the Web GUI. It has no dependencies and no build step, so a local-directory install is enough.

## Before you start

- DeepSeek Harness Desktop or `dsh web` at version `0.2.x`.
- The directory containing `package.json`, `index.js`, and `client.js` (this one).
- Optional: a working Harness model route for AI summaries, translation, classification, and Q&A. Defaults come from **Settings → Models**; the plugin stores no API key.

## Option A — install from the GUI

1. Open **Settings → Plugins**.
2. Choose **Add plugin** and select **local directory** (the exact wording depends on the DSH build).
3. Pick this directory.
4. Enable the **RSS reader** bundle if it is not enabled automatically.
5. Reload the page once.

The plugin appears in the plugin list with the RSS icon. Its row is named `rss` and its package is `dsh-plugin-rss`.

## Option B — install from an agent session

Ask the agent to install the bundle with the absolute path of this directory:

```text
plugin_manager action=install_bundle target=/absolute/path/to/dsh-plugin-rss
```

Installation links the directory, adds the bundle to the profile, and activates the `rss` row. There are no install scripts, so no build approval is needed.

## Option C — install from npm

```text
plugin_manager action=install_bundle target=dsh-plugin-rss
```

Pin a version with `target=dsh-plugin-rss@1.0.0`. The package has no dependencies and no install scripts, so no build approval is needed.

## Verify

1. In the sidebar panel rail (next to Plugins, Schedules, and Prompt library), an **RSS** icon appears.
2. Click it. The three-pane reader opens with **All articles** selected.
3. Click **+**, paste `https://hnrss.org/frontpage`, and press **Add feed**. The feed is validated, its current entries are imported, and they appear in the list.
4. Select an article. The reader renders its body; **Open original**, **Full text**, **Star**, **Read later**, and **Mark read** work.
5. Open the **AI assistant** card and choose **Summary**. If no model is configured, the card explains that no language model is available; configure one in **Settings → Models** and retry.
6. In **Settings** inside the RSS panel, set an explicit AI provider/model if you want RSS to use a different route from the Harness default.
7. Click **Discover feeds** in the sidebar footer. Choose one or more inferred topics (none are selected by default), choose **Recommend feeds**, select a verified suggestion, and add it. The feed appears in the rail with its current articles. Without a configured model, curated catalog suggestions still appear.

You can also verify from chat:

```text
Use rss_feeds with action=list.
Use rss_articles with view=unread.
Use rss_discover with action=topics.
```

## Where the data lives

`$DSH_HOME/rss/data.json`. For the desktop profile this is `~/.dsh/rss/data.json`.

- The file is written atomically with mode `0600`.
- To reset the library, quit DSH, delete that file, and restart. Starter feeds are recreated only when the file is created fresh.
- A corrupt file is automatically renamed to `data.json.corrupt-<timestamp>` and replaced.

## Configuration

Defaults work as shipped. To change them, edit the `rss` row's `config` in the profile patch (`$DSH_HOME/profiles/<profile>/cordis.patch.yml`) or through whatever configuration surface your DSH build provides for bundle rows.

```yaml
- insert:
    - id: rss
      name: 'dsh-plugin-rss'
      config:
        refreshMinutes: 30
        maxArticles: 3000
        pageSize: 40
        allowPrivateHosts: false
        seedFeeds: true
        aiProvider: ''
        aiModel: ''
        autoClassify: false
        translateTo: ''
```

See the README's configuration section for every field.

## Troubleshooting

| Symptom | Fix |
|---|---|
| No RSS icon after install | Reload the page once; confirm the bundle row is enabled in **Plugins**. |
| Panel opens but lists nothing | Add a feed, or click **Refresh all**. Starter feeds need network access. |
| “No language model is available” | Configure a model in **Settings → Models**, or set `aiProvider`/`aiModel` in the RSS settings. |
| Feed shows a red dot | Hover the feed for the error. Common causes: invalid URL, TLS failure, HTTP 403, timeout, or a private/loopback host. Try the site's advertised feed URL. |
| A LAN feed is blocked | Loopback/private hosts are rejected by default. Set `allowPrivateHosts: true` in the RSS row configuration. |
| AI says “Too many AI requests are running” | Wait for the current request to finish; at most two run at once. |
| Summary is cached in the wrong language | Change the language in **Settings**, then use **Regenerate** (or call `rss_ai` with `force`). |
| Full text fails | The page may be paywalled, JavaScript-rendered, or larger than `maxPageBytes`. |

## Uninstall

- **Plugins → RSS reader → Remove**, or `plugin_manager action=remove_bundle target=dsh-plugin-rss`.
- The data file under `$DSH_HOME/rss/` is left in place; delete it manually to remove subscriptions and reading state.

## Development install

For iterating on the plugin, install the local directory once. Changes to `index.js`/`src/` take effect after disabling and re-enabling the bundle (or restarting DSH). Changes to `client.js` may require a page reload, depending on the profile's HMR setup.

Run the test suite before installing:

```sh
node --test test/*.test.js
```
