pub mod host_api;
pub mod manifest;
pub mod runtime;

use manifest::LoadedPlugin;
use std::path::Path;

/// Load plugins from a directory.
pub fn load_plugins_from_dir(plugins_dir: &Path) -> Vec<LoadedPlugin> {
    manifest::load_plugins_from_dir(plugins_dir)
}
