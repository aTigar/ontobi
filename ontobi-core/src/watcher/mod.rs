use anyhow::{Context, Result};
use notify_debouncer_mini::{
    new_debouncer,
    notify::RecursiveMode,
    DebouncedEvent,
};
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::Duration;

use crate::endpoint;
use crate::store::{OntobiStore, default_persistence_path};

// ── Public entry point ────────────────────────────────────────────────────────

/// `ontobi serve` command:
///
/// 1. Create an in-memory store and load N-Quads persistence (if it exists).
/// 2. Optionally index the vault.
/// 3. Spawn the SPARQL HTTP endpoint as a background tokio task.
/// 4. Watch for `.md` file changes (debounced 500 ms).
/// 5. On Ctrl+C: stop watching, dump the store, exit.
pub async fn serve(vault: String, port: u16, index: bool) -> Result<()> {
    let vault_path = PathBuf::from(&vault);
    if !vault_path.exists() {
        anyhow::bail!("vault path does not exist: {}", vault_path.display());
    }

    // ── store ─────────────────────────────────────────────────────────────────
    let store = OntobiStore::new().context("creating store")?;
    let persist_path = default_persistence_path(&vault_path);

    store
        .load_from_file(&persist_path)
        .context("loading persistence")?;

    if index {
        let n = store
            .index_vault(&vault_path)
            .context("indexing vault")?;
        tracing::info!(files = n, "vault indexed");
    }

    // ── endpoint (background) ─────────────────────────────────────────────────
    let endpoint_store = store.clone();
    tokio::spawn(async move {
        if let Err(e) = endpoint::serve(endpoint_store, port).await {
            tracing::error!("endpoint error: {e:#}");
        }
    });

    tracing::info!(port, vault = %vault_path.display(), "ontobi serving");

    // ── file watcher ──────────────────────────────────────────────────────────
    let (tx, rx) = mpsc::channel();
    let mut debouncer = new_debouncer(Duration::from_millis(500), tx)
        .context("creating file watcher")?;
    debouncer
        .watcher()
        .watch(&vault_path, RecursiveMode::Recursive)
        .context("watching vault")?;

    // ── Ctrl+C shutdown ───────────────────────────────────────────────────────
    let ctrlc_store = store.clone();
    let ctrlc_persist = persist_path.clone();
    tokio::spawn(async move {
        if tokio::signal::ctrl_c().await.is_ok() {
            tracing::info!("shutting down…");
            if let Err(e) = ctrlc_store.dump_to_file(&ctrlc_persist) {
                tracing::error!("dump failed: {e:#}");
            } else {
                tracing::info!(path = %ctrlc_persist.display(), "store saved");
            }
            std::process::exit(0);
        }
    });

    // ── event loop ────────────────────────────────────────────────────────────
    for events in rx {
        match events {
            Ok(events) => {
                for DebouncedEvent { path, .. } in events {
                    handle_event(&store, &vault_path, &path);
                }
            }
            Err(e) => {
                tracing::warn!("watcher error: {e}");
            }
        }
    }

    Ok(())
}

// ── Private helpers ───────────────────────────────────────────────────────────

fn handle_event(store: &OntobiStore, vault_path: &Path, path: &Path) {
    // Ignore non-.md files
    if path.extension().and_then(|s| s.to_str()) != Some("md") {
        return;
    }

    if path.exists() {
        // Created or modified
        match store.reindex_file(vault_path, path) {
            Ok(()) => tracing::info!("reindexed {}", path.display()),
            Err(e) => tracing::warn!("reindex failed for {}: {e:#}", path.display()),
        }
    } else {
        // Deleted
        match store.remove_file(vault_path, path) {
            Ok(()) => tracing::info!("removed {}", path.display()),
            Err(e) => tracing::warn!("remove failed for {}: {e:#}", path.display()),
        }
    }
}
