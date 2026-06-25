use openusage_plugin_engine::manifest::LoadedPlugin;
use openusage_plugin_engine::runtime::{MetricLine, PluginOutput, ProgressFormat};
use serde::{Deserialize, Serialize};
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::PathBuf;
use std::time::{Duration, SystemTime};

#[derive(Serialize, Deserialize)]
struct WaybarOutput {
    text: String,
    tooltip: String,
    class: String,
    percentage: u8,
}

fn find_plugins_dir() -> Option<PathBuf> {
    // 1. OPENUSAGE_PLUGINS_DIR env var
    if let Ok(dir) = std::env::var("OPENUSAGE_PLUGINS_DIR") {
        let path = PathBuf::from(dir);
        if path.is_dir() {
            return Some(path);
        }
    }

    // 2. XDG data dir: ~/.local/share/openusage/plugins
    if let Some(data_dir) = dirs::data_dir() {
        let path = data_dir.join("openusage").join("plugins");
        if path.is_dir() {
            return Some(path);
        }
    }

    // 3. ~/.config/openusage/plugins
    if let Some(config_dir) = dirs::config_dir() {
        let path = config_dir.join("openusage").join("plugins");
        if path.is_dir() {
            return Some(path);
        }
    }

    // 4. System-wide install (e.g. AUR / distro packages): /usr/share/openusage/plugins
    let system = PathBuf::from("/usr/share/openusage/plugins");
    if system.is_dir() {
        return Some(system);
    }

    // 5. Development: ./plugins or ../plugins relative to cwd
    if let Ok(cwd) = std::env::current_dir() {
        let direct = cwd.join("plugins");
        if direct.is_dir() {
            return Some(direct);
        }
        let parent = cwd.join("..").join("plugins");
        if parent.is_dir() {
            return Some(parent);
        }
    }

    None
}

fn app_data_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("OPENUSAGE_DATA_DIR") {
        return PathBuf::from(dir);
    }
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("/tmp"))
        .join("openusage")
}

// Manual-refresh state lives in a per-module pair of files (cache + reload flag),
// keyed by the set of selected plugins so multiple Waybar modules don't collide.
struct RefreshState {
    cache: PathBuf,
    reload: PathBuf,
}

// Ignore reload flags older than this; protects against a stuck loading frame if
// the refresh worker dies between writing the flag and clearing it.
const RELOAD_FLAG_MAX_AGE: Duration = Duration::from_secs(20);

fn refresh_state(app_data: &PathBuf, plugin_ids: &[&str]) -> RefreshState {
    let mut sorted: Vec<&str> = plugin_ids.to_vec();
    sorted.sort_unstable();
    let key = if sorted.is_empty() {
        "all".to_string()
    } else {
        let mut hasher = DefaultHasher::new();
        sorted.join(",").hash(&mut hasher);
        format!("{:016x}", hasher.finish())
    };
    RefreshState {
        cache: app_data.join(format!("waybar-{key}.cache.json")),
        reload: app_data.join(format!("waybar-{key}.reload")),
    }
}

fn file_age(path: &PathBuf) -> Option<Duration> {
    let modified = std::fs::metadata(path).ok()?.modified().ok()?;
    SystemTime::now().duration_since(modified).ok()
}

// A fresh reload flag means the user just asked for a refresh and we should show a
// loading frame instead of fetching.
fn reload_pending(state: &RefreshState) -> bool {
    match file_age(&state.reload) {
        Some(age) => age <= RELOAD_FLAG_MAX_AGE,
        None => false,
    }
}

fn write_cache(state: &RefreshState, output: &WaybarOutput) {
    if let Ok(json) = serde_json::to_string(output) {
        let _ = std::fs::write(&state.cache, json);
    }
}

fn read_cache(state: &RefreshState) -> Option<WaybarOutput> {
    let json = std::fs::read_to_string(&state.cache).ok()?;
    serde_json::from_str(&json).ok()
}

// Loading frame: keep the previous tooltip/percentage so hover stays useful, but
// flag the bar as reloading (style via the `.reloading` CSS class).
fn loading_output(state: &RefreshState) -> WaybarOutput {
    match read_cache(state) {
        Some(prev) => WaybarOutput {
            text: format!("{} ", prev.text.trim()),
            tooltip: prev.tooltip,
            class: "reloading".to_string(),
            percentage: prev.percentage,
        },
        None => WaybarOutput {
            text: " reloading".to_string(),
            tooltip: "Reloading…".to_string(),
            class: "reloading".to_string(),
            percentage: 0,
        },
    }
}

fn send_waybar_signal(signal: u8) {
    let spec = format!("-SIGRTMIN+{signal}");
    let _ = std::process::Command::new("pkill")
        .arg(spec)
        .arg("waybar")
        .status();
}

// Right-click worker: flash a loading frame, then trigger the real fetch. The
// worker owns the flag lifecycle so the display `exec` never deletes it, which
// avoids a race between the two signals.
fn run_refresh_worker(state: &RefreshState, signal: Option<u8>) {
    let Some(signal) = signal else {
        eprintln!("--refresh requires --signal N (the Waybar `signal` value)");
        std::process::exit(2);
    };

    // 1. Raise the flag and ask Waybar to re-render -> shows the loading frame.
    let _ = std::fs::write(&state.reload, b"");
    send_waybar_signal(signal);

    // 2. Give Waybar time to pick up the loading frame before clearing the flag.
    std::thread::sleep(Duration::from_millis(350));

    // 3. Clear the flag and re-render -> the display `exec` now fetches fresh.
    let _ = std::fs::remove_file(&state.reload);
    send_waybar_signal(signal);
}

fn used_percentage(used: f64, limit: f64) -> u8 {
    if limit <= 0.0 {
        return 0;
    }
    let pct = (used / limit * 100.0).round() as u8;
    pct.min(100)
}

#[derive(Clone, Copy)]
struct Severity {
    color: &'static str,
    class: &'static str,
}

const SEV_NORMAL: Severity = Severity { color: "#22c55e", class: "normal" };
const SEV_WARN: Severity = Severity { color: "#eab308", class: "warning" };
const SEV_CRIT: Severity = Severity { color: "#ef4444", class: "critical" };

// Treat usage within this many points of the time marker as on-pace. Avoids
// flapping to yellow on the 99%-left/100%-time-remaining cycle-start case.
const PACE_GRACE_PCT: u8 = 5;

// When `time_remaining_pct` is known, severity is set by usage relative to where
// we are in the refresh cycle: ahead of pace = green, behind = yellow, less than
// half the time-remaining left in usage = red. Without a known cycle length,
// fall back to absolute used-percent thresholds.
fn severity(used_pct: u8, time_remaining_pct: Option<u8>) -> Severity {
    let remaining_pct = 100u8.saturating_sub(used_pct);
    match time_remaining_pct {
        Some(t) => {
            if remaining_pct.saturating_add(PACE_GRACE_PCT) >= t {
                SEV_NORMAL
            } else if (remaining_pct as u16) * 2 < t as u16 {
                SEV_CRIT
            } else {
                SEV_WARN
            }
        }
        None => {
            if used_pct >= 90 {
                SEV_CRIT
            } else if used_pct >= 75 {
                SEV_WARN
            } else {
                SEV_NORMAL
            }
        }
    }
}

const BAR_CELLS: usize = 20;

fn build_progress_bar(used_pct: u8, time_remaining_pct: Option<u8>) -> String {
    let remaining_pct = 100u8.saturating_sub(used_pct);
    let filled = if remaining_pct > 0 {
        ((remaining_pct as usize * BAR_CELLS) / 100)
            .max(1)
            .min(BAR_CELLS)
    } else {
        0
    };
    let bar_color = severity(used_pct, time_remaining_pct).color;
    let empty_color = "#4b5563";
    let marker_color = "#e5e7eb";

    let marker_idx = time_remaining_pct.map(|t| {
        let t = t.min(100) as usize;
        ((t * BAR_CELLS) / 100).min(BAR_CELLS - 1)
    });

    // All cells emit `background=` so the marker's `▌` cell-box matches the
    // surrounding `█` cells and the bar doesn't look bumpy at the marker.
    let cell = |i: usize| -> (&'static str, &'static str, &'static str) {
        if Some(i) == marker_idx {
            let bg = if i < filled { bar_color } else { empty_color };
            ("▌", marker_color, bg)
        } else if i < filled {
            ("█", bar_color, bar_color)
        } else {
            ("█", empty_color, empty_color)
        }
    };

    let mut out = String::new();
    let mut i = 0;
    while i < BAR_CELLS {
        let c = cell(i);
        let mut j = i + 1;
        while j < BAR_CELLS && cell(j) == c {
            j += 1;
        }
        let (ch, fg, bg) = c;
        let segment: String = ch.repeat(j - i);
        out.push_str(&format!(
            "<span foreground=\"{fg}\" background=\"{bg}\">{segment}</span>"
        ));
        i = j;
    }
    out
}

fn parse_resets_dur(resets_at: &str) -> Option<time::Duration> {
    use time::OffsetDateTime;
    use time::format_description::well_known::Iso8601;

    let target = OffsetDateTime::parse(resets_at, &Iso8601::DEFAULT).ok()?;
    Some(target - OffsetDateTime::now_utc())
}

// 100 = period just started, 0 = period about to reset.
fn time_remaining_pct(dur: time::Duration, period_ms: u64) -> u8 {
    if period_ms == 0 || dur.is_negative() {
        return 0;
    }
    let pct = (dur.whole_milliseconds() as f64 / period_ms as f64 * 100.0).round();
    pct.clamp(0.0, 100.0) as u8
}

fn format_resets_in(dur: time::Duration) -> String {
    if dur.is_negative() {
        return "Expired".to_string();
    }
    let total_secs = dur.whole_seconds();
    let days = total_secs / 86400;
    let hours = (total_secs % 86400) / 3600;
    let mins = (total_secs % 3600) / 60;

    if days > 0 {
        format!("Resets in {}d {}h", days, hours)
    } else if hours > 0 {
        format!("Resets in {}h {}m", hours, mins)
    } else {
        format!("Resets in {}m", mins)
    }
}

fn format_remaining(used: f64, limit: f64, format: &ProgressFormat) -> String {
    let remaining = (limit - used).max(0.0);
    match format {
        ProgressFormat::Percent => {
            let pct = if limit > 0.0 {
                (remaining / limit * 100.0).round()
            } else {
                0.0
            };
            format!("{:.0}% left", pct)
        }
        ProgressFormat::Dollars => {
            format!("${:.2} left", remaining)
        }
        ProgressFormat::Count { suffix } => {
            format!("{:.0} {} left", remaining, pango_escape(suffix))
        }
    }
}

struct ProgressInfo {
    provider: String,
    pct: u8,
    time_remaining_pct: Option<u8>,
}

fn progress_info_from(line: &MetricLine, provider: &str) -> Option<ProgressInfo> {
    let MetricLine::Progress {
        used,
        limit,
        resets_at,
        period_duration_ms,
        ..
    } = line
    else {
        return None;
    };
    let pct = used_percentage(*used, *limit);
    let time_remaining_pct = resets_at
        .as_deref()
        .and_then(parse_resets_dur)
        .zip(*period_duration_ms)
        .map(|(d, p)| time_remaining_pct(d, p));
    Some(ProgressInfo {
        provider: provider.to_string(),
        pct,
        time_remaining_pct,
    })
}

fn extract_primary_progress(plugin: &LoadedPlugin, output: &PluginOutput) -> Option<ProgressInfo> {
    let mut candidates: Vec<_> = plugin
        .manifest
        .lines
        .iter()
        .filter(|l| l.line_type == "progress" && l.primary_order.is_some())
        .collect();
    candidates.sort_by_key(|l| l.primary_order.unwrap());

    for candidate in &candidates {
        for line in &output.lines {
            if let MetricLine::Progress { label, .. } = line {
                if label == &candidate.label {
                    return progress_info_from(line, &output.display_name);
                }
            }
        }
    }

    output
        .lines
        .iter()
        .find_map(|l| progress_info_from(l, &output.display_name))
}

fn pango_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

fn build_tooltip_for_output(output: &PluginOutput) -> String {
    let mut parts: Vec<String> = Vec::new();

    // Header: provider name + plan badge
    let name = pango_escape(&output.display_name);
    let header = if let Some(plan) = &output.plan {
        let plan = pango_escape(plan);
        format!("<b>{name}</b>  <span bgcolor=\"#374151\" fgcolor=\"#e5e7eb\"> {plan} </span>",)
    } else {
        format!("<b>{name}</b>")
    };
    parts.push(header);

    for line in &output.lines {
        match line {
            MetricLine::Progress {
                label,
                used,
                limit,
                format,
                resets_at,
                period_duration_ms,
                ..
            } => {
                let label = pango_escape(label);
                let used_pct = used_percentage(*used, *limit);
                let resets_dur = resets_at.as_deref().and_then(parse_resets_dur);
                let time_pct = resets_dur
                    .zip(*period_duration_ms)
                    .map(|(d, p)| time_remaining_pct(d, p));
                let color = severity(used_pct, time_pct).color;
                let dot = format!("<span foreground=\"{color}\">●</span>");
                let bar = build_progress_bar(used_pct, time_pct);
                let remaining = format_remaining(*used, *limit, format);
                let resets = resets_dur.map(format_resets_in).unwrap_or_default();

                parts.push(format!("<b>{label}</b> {dot}"));
                parts.push(bar);
                if resets.is_empty() {
                    parts.push(remaining);
                } else {
                    parts.push(format!("{remaining}    {resets}"));
                }
            }
            MetricLine::Text { label, value, .. } => {
                let label = pango_escape(label);
                let value = pango_escape(value);
                parts.push(format!("{label}: {value}"));
            }
            MetricLine::Badge { label, text, .. } => {
                let label = pango_escape(label);
                let text = pango_escape(text);
                parts.push(format!("{label}: {text}"));
            }
        }
    }

    parts.join("\n")
}

fn run_plugins(plugins: &[LoadedPlugin], app_data: &PathBuf) -> Vec<PluginOutput> {
    let version = env!("CARGO_PKG_VERSION");
    plugins
        .iter()
        .map(|plugin| openusage_plugin_engine::runtime::run_probe(plugin, app_data, version))
        .collect()
}

fn parse_args() -> Vec<String> {
    std::env::args().skip(1).collect()
}

// Pull `--signal N` out of the args, returning the value and the remaining args.
fn take_signal(args: Vec<String>) -> (Option<u8>, Vec<String>) {
    let mut signal = None;
    let mut rest = Vec::new();
    let mut iter = args.into_iter();
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "--signal" => {
                signal = iter.next().and_then(|v| v.parse::<u8>().ok());
            }
            other if other.starts_with("--signal=") => {
                signal = other["--signal=".len()..].parse::<u8>().ok();
            }
            _ => rest.push(arg),
        }
    }
    (signal, rest)
}

fn main() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("warn"))
        .format_timestamp(None)
        .init();

    let (signal, args) = take_signal(parse_args());
    let refresh_mode = args.iter().any(|a| a == "--refresh");

    if args.iter().any(|a| a == "--help" || a == "-h") {
        eprintln!("Usage: openusage-waybar [OPTIONS] [PLUGIN_ID...]");
        eprintln!();
        eprintln!("Runs OpenUsage plugins and outputs waybar-compatible JSON.");
        eprintln!();
        eprintln!("Arguments:");
        eprintln!("  [PLUGIN_ID...]  Plugin IDs to run (default: all)");
        eprintln!();
        eprintln!("Options:");
        eprintln!("  --list          List available plugins and exit");
        eprintln!("  --json          Output full plugin results as JSON");
        eprintln!("  --refresh       Trigger a manual refresh (for on-click-right);");
        eprintln!("                  requires --signal N. Flashes a reloading state");
        eprintln!("                  then signals Waybar to fetch fresh data.");
        eprintln!("  --signal N      Waybar `signal` value to notify on refresh");
        eprintln!("  -h, --help      Show this help");
        eprintln!();
        eprintln!("Environment:");
        eprintln!("  OPENUSAGE_PLUGINS_DIR  Path to plugins directory");
        eprintln!("  OPENUSAGE_DATA_DIR     Path to app data directory");
        eprintln!("  RUST_LOG               Log level (default: warn)");
        eprintln!();
        eprintln!("Plugin search order (first match wins):");
        eprintln!("  1. $OPENUSAGE_PLUGINS_DIR");
        eprintln!("  2. ~/.local/share/openusage/plugins");
        eprintln!("  3. ~/.config/openusage/plugins");
        eprintln!("  4. /usr/share/openusage/plugins");
        eprintln!("  5. ./plugins or ../plugins (development)");
        eprintln!();
        eprintln!("Waybar config example:");
        eprintln!("  \"custom/openusage\": {{");
        eprintln!("    \"exec\": \"openusage-waybar claude\",");
        eprintln!("    \"return-type\": \"json\",");
        eprintln!("    \"interval\": 300,");
        eprintln!("    \"signal\": 8,");
        eprintln!("    \"on-click-right\": \"openusage-waybar --refresh --signal 8 claude\"");
        eprintln!("  }}");
        std::process::exit(0);
    }

    let plugin_ids: Vec<&str> = args
        .iter()
        .filter(|a| !a.starts_with('-'))
        .map(|s| s.as_str())
        .collect();

    let app_data = app_data_dir();
    let _ = std::fs::create_dir_all(&app_data);
    let state = refresh_state(&app_data, &plugin_ids);

    // Right-click refresh worker: flash a loading frame, then signal a real fetch.
    if refresh_mode {
        run_refresh_worker(&state, signal);
        std::process::exit(0);
    }

    // A pending reload flag means render a loading frame instead of fetching; the
    // worker clears the flag and re-signals to trigger the actual fetch.
    if reload_pending(&state) {
        println!("{}", serde_json::to_string(&loading_output(&state)).unwrap());
        std::process::exit(0);
    }

    let plugins_dir = match find_plugins_dir() {
        Some(dir) => dir,
        None => {
            let output = WaybarOutput {
                text: "no plugins".to_string(),
                tooltip: "OpenUsage: plugins directory not found.\nInstall via your package manager, set OPENUSAGE_PLUGINS_DIR, or place plugins in ~/.local/share/openusage/plugins/".to_string(),
                class: "critical".to_string(),
                percentage: 0,
            };
            println!("{}", serde_json::to_string(&output).unwrap());
            std::process::exit(0);
        }
    };

    log::info!("plugins dir: {}", plugins_dir.display());

    let all_plugins = openusage_plugin_engine::load_plugins_from_dir(&plugins_dir);

    if args.iter().any(|a| a == "--list") {
        for plugin in &all_plugins {
            println!("{} ({})", plugin.manifest.id, plugin.manifest.name);
        }
        std::process::exit(0);
    }

    let selected: Vec<LoadedPlugin> = if plugin_ids.is_empty() {
        all_plugins
    } else {
        all_plugins
            .into_iter()
            .filter(|p| plugin_ids.contains(&p.manifest.id.as_str()))
            .collect()
    };

    if selected.is_empty() {
        let output = WaybarOutput {
            text: "no plugins".to_string(),
            tooltip: "OpenUsage: no matching plugins found".to_string(),
            class: "critical".to_string(),
            percentage: 0,
        };
        println!("{}", serde_json::to_string(&output).unwrap());
        std::process::exit(0);
    }

    let full_json = args.iter().any(|a| a == "--json");

    let outputs = run_plugins(&selected, &app_data);

    if full_json {
        println!("{}", serde_json::to_string(&outputs).unwrap());
        std::process::exit(0);
    }

    // Build waybar output
    let mut primary_progress: Vec<ProgressInfo> = Vec::new();
    let mut tooltip_sections: Vec<String> = Vec::new();

    for (plugin, output) in selected.iter().zip(outputs.iter()) {
        if let Some(info) = extract_primary_progress(plugin, output) {
            primary_progress.push(info);
        }
        tooltip_sections.push(build_tooltip_for_output(output));
    }

    let (text, pct, class) = if primary_progress.is_empty() {
        let has_errors = outputs.iter().any(|o| {
            o.lines
                .iter()
                .any(|l| matches!(l, MetricLine::Badge { label, .. } if label == "Error"))
        });
        if has_errors {
            ("err".to_string(), 0u8, "critical")
        } else {
            ("ok".to_string(), 0u8, "normal")
        }
    } else {
        // Pick the provider with the worst severity; tie-break by used percentage.
        let worst = primary_progress
            .iter()
            .max_by_key(|p| {
                let rank = match severity(p.pct, p.time_remaining_pct).class {
                    "critical" => 2,
                    "warning" => 1,
                    _ => 0,
                };
                (rank, p.pct)
            })
            .unwrap();
        let remaining = 100u8.saturating_sub(worst.pct);
        let text = format!("{} {}%", worst.provider, remaining);
        let class = severity(worst.pct, worst.time_remaining_pct).class;
        (text, worst.pct, class)
    };

    let tooltip = tooltip_sections.join("\n\n");

    let output = WaybarOutput {
        text,
        tooltip,
        class: class.to_string(),
        percentage: 100u8.saturating_sub(pct),
    };

    // Persist the rendered output so a manual refresh can show a loading frame
    // that keeps the previous tooltip until fresh data arrives.
    write_cache(&state, &output);

    println!("{}", serde_json::to_string(&output).unwrap());
}
