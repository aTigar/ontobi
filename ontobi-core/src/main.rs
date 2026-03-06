mod parser;
mod store;
mod triples;
mod endpoint;
mod watcher;

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};

#[derive(Parser)]
#[command(name = "ontobi", version, about = "SKOS knowledge graph server")]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Index a vault and start the SPARQL endpoint
    Serve {
        /// Path to the Obsidian vault root.
        /// Falls back to the ONTOBI_VAULT_PATH environment variable if not set.
        #[arg(long)]
        vault: Option<String>,
        /// SPARQL endpoint port (default: 14321)
        #[arg(long, default_value_t = 14321)]
        port: u16,
        /// Skip vault indexing on startup and load from persisted store.nq instead.
        /// Useful for fast restarts when the vault has not changed.
        #[arg(long, default_value_t = false)]
        no_index: bool,
    },
    /// Index a vault and exit (no server). Writes store.nq for fast cold starts.
    Index {
        /// Path to the Obsidian vault root.
        /// Falls back to the ONTOBI_VAULT_PATH environment variable if not set.
        #[arg(long)]
        vault: Option<String>,
    },
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::from_default_env()
                .add_directive("ontobi=info".parse()?),
        )
        .with_writer(std::io::stderr)
        .init();

    let cli = Cli::parse();

    match cli.command {
        Commands::Serve { vault, port, no_index } => {
            let vault = resolve_vault(vault)?;
            watcher::serve(vault, port, !no_index).await?;
        }
        Commands::Index { vault } => {
            let vault = resolve_vault(vault)?;
            store::index_vault_and_exit(&vault).await?;
        }
    }

    Ok(())
}

/// Resolve the vault path from the CLI argument or the ONTOBI_VAULT_PATH env var.
///
/// `--vault` takes precedence. If neither is provided the binary exits with a
/// clear error rather than a cryptic panic.
fn resolve_vault(vault: Option<String>) -> Result<String> {
    vault
        .or_else(|| std::env::var("ONTOBI_VAULT_PATH").ok())
        .context(
            "vault path is required: use --vault <path> or set the ONTOBI_VAULT_PATH environment variable",
        )
}
