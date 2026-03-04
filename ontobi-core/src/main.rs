mod parser;
mod store;
mod triples;
mod endpoint;
mod watcher;

use anyhow::Result;
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
        /// Path to the Obsidian vault root
        #[arg(long)]
        vault: String,
        /// SPARQL endpoint port (default: 14321)
        #[arg(long, default_value_t = 14321)]
        port: u16,
        /// Index vault on startup (default: true)
        #[arg(long, default_value_t = true)]
        index: bool,
    },
    /// Index a vault and exit (no server)
    Index {
        /// Path to the Obsidian vault root
        #[arg(long)]
        vault: String,
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
        Commands::Serve { vault, port, index } => {
            watcher::serve(vault, port, index).await?;
        }
        Commands::Index { vault } => {
            store::index_vault_and_exit(&vault).await?;
        }
    }

    Ok(())
}
