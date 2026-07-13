# code.md
Machine-generated structural truth for this repository.
Used by coding agents to understand architecture, flow, and dependencies.

Generated for local-path/vscode-extension-graphs-9002d610 from direct repository evidence only. No LLM summaries, feature catalog, embeddings, vectors, train pairs, or model-layer files are used.
Only deterministic sections requested by the user are included.

## api_routes
Evidence: deterministic Python decorator parsing plus exact JavaScript/TypeScript route-call parsing from source files.
_No rows found from the available direct evidence._

## entry_points
Evidence: exact `entry_points` array from the selected callgraph artifact.
| Node | Out-degree | In-degree |
| --- | --- | --- |
| api.analytics_map-activity-to-code | 1 | 2 |
| api.analyze | 1 | 11 |
| api.analyze_local_path | 1 | 0 |
| api.analyze_local_path_start | 1 | 0 |
| api.analyze_start | 1 | 1 |
| api.analyze_status_job_id | 1 | 0 |
| api.analyze_upload | 1 | 8 |
| api.api | 1 | 0 |
| api.api.html | 1 | 0 |
| api.artifact_render | 1 | 1 |
| api.code-md | 1 | 2 |
| api.code-notes | 1 | 9 |
| api.contact | 1 | 10 |
| api.dashboard | 1 | 4 |
| api.dashboard.html | 1 | 0 |
| api.dashboard.xml | 1 | 0 |
| api.debug_github-oauth | 1 | 0 |
| api.debug_google-analytics-oauth | 1 | 0 |
| api.debug_output-files | 1 | 0 |
| api.debug_output_repo_folder_filename | 1 | 0 |
| api.demo | 1 | 0 |
| api.demo.html | 1 | 0 |
| api.favicon.ico | 1 | 0 |
| api.feature-summary | 1 | 11 |
| api.files | 1 | 0 |
| api.function-summaries | 1 | 3 |
| api.github_analyze | 1 | 1 |
| api.github_callback | 1 | 0 |
| api.github_daily-change-graph | 1 | 8 |
| api.github_daily-commit-graph | 1 | 1 |
| api.github_daily-commits | 1 | 0 |
| api.github_daily-summary | 1 | 8 |
| api.github_daily-summary-prompt | 1 | 8 |
| api.github_login | 1 | 0 |
| api.github_logout | 1 | 0 |
| api.github_me | 1 | 10 |
| api.github_reconnect | 1 | 1 |
| api.github_repos | 1 | 10 |
| api.github_saved-analyses | 1 | 0 |
| api.github_saved-analyses_latest | 1 | 8 |
| api.github_webhook | 1 | 0 |
| api.google-analytics_callback | 1 | 0 |
| api.google-analytics_callgraph-events | 1 | 8 |
| api.google-analytics_event-callgraph | 1 | 8 |
| api.google-analytics_login | 1 | 0 |
| api.google-analytics_logout | 1 | 0 |
| api.google-analytics_me | 1 | 10 |
| api.google-analytics_properties | 1 | 10 |
| api.google-analytics_rebuild-event-traces | 1 | 0 |
| api.google-analytics_reconnect | 1 | 1 |
| api.google-analytics_register-error-dimensions | 1 | 8 |
| api.index.html | 1 | 0 |
| api.mixpanel_connect | 1 | 1 |
| api.mixpanel_connection-status | 1 | 1 |
| api.mixpanel_event-callgraph | 1 | 1 |
| api.mixpanel_load-user-activity | 1 | 1 |
| api.output-zips | 1 | 0 |
| api.playwright_start | 1 | 7 |
| api.playwright_status_job_id | 1 | 0 |
| api.product-feature-metadata | 1 | 10 |
| api.quality-signals | 1 | 8 |
| api.quality-signals_analyze | 1 | 7 |
| api.quality-signals_apply | 1 | 6 |
| api.quality-signals_evaluate | 1 | 6 |
| api.quality-signals_resolve | 1 | 8 |
| api.quality-signals_validate | 1 | 6 |
| api.robots.txt | 1 | 0 |
| api.root | 1 | 0 |
| api.sample | 1 | 0 |
| api.sample-analysis | 1 | 6 |
| api.sample.html | 1 | 0 |
| api.scoped-callgraph | 1 | 9 |
| api.search | 1 | 15 |
| api.search-answer | 1 | 10 |
| api.search-answer-feedback | 1 | 0 |
| api.search-result-graph | 1 | 0 |
| api.searchOLD | 1 | 0 |
| api.self-healing_analyze | 1 | 8 |
| api.self-healing_apply | 1 | 8 |
| api.self-healing_evaluate | 1 | 8 |

## risky_functions
Evidence: callgraph in-degree count only. Higher in-degree means more callers in the extracted graph.
| Node | In-degree | Out-degree | Total degree |
| --- | --- | --- | --- |
| backend__main__PathRegistry__path | 116 | 0 | 116 |
| url.link | 67 | 0 | 67 |
| backend__features__core__helpers__artifact_root_for_output | 62 | 0 | 62 |
| js.togglePanel | 54 | 0 | 54 |
| backend__main__search | 53 | 58 | 111 |
| backend.main.repo_output_dir | 47 | 1 | 48 |
| backend__main__repo_output_dir | 47 | 2 | 49 |
| backend__main__build_javascript_tree_sitter_callgraphX__walk | 39 | 5 | 44 |
| backend__main__build_tree_sitter_java_callgraphX__walk | 39 | 5 | 44 |
| backend__main__callgraphX_nodeXs_for_mapping__walk | 39 | 1 | 40 |
| backend__main__extract_json_text_values__walk | 39 | 1 | 40 |
| backend.main.supabase_execute | 34 | 0 | 34 |
| backend__main__supabase_execute | 34 | 0 | 34 |
| backend__main__choose_output_root | 27 | 0 | 27 |
| backend__main__supabase_runtime_client | 26 | 1 | 27 |
| backend.main.scoped_callgraph_code_units.add | 25 | 2 | 27 |
| backend.main.supabase_runtime_client | 25 | 1 | 26 |
| event.change | 25 | 0 | 25 |
| backend.main.should_skip_path | 23 | 1 | 24 |
| backend__main__should_skip_path | 23 | 2 | 25 |
| backend.main.function_tail | 22 | 0 | 22 |
| backend__main__function_tail | 22 | 0 | 22 |
| backend__main__search_query_terms | 22 | 3 | 25 |
| backend.main.search_query_terms | 21 | 3 | 24 |
| backend__features__core__helpers__load_search_callgraphX | 21 | 0 | 21 |
| backend__main__load_scim_function_records | 21 | 0 | 21 |
| backend__main__load_search_callgraphX | 20 | 1 | 21 |
| event.click | 20 | 0 | 20 |
| backend.main.load_scim_function_records | 19 | 0 | 19 |
| backend.main.load_search_callgraph | 19 | 0 | 19 |

## top_connected_nodes
Evidence: total callgraph degree count only.
| Node | Total degree | In-degree | Out-degree |
| --- | --- | --- | --- |
| backend_static_experiment_html.file | 330 | 0 | 330 |
| backend_static_BACKUP_dashboardv1_html.file | 215 | 0 | 215 |
| backend_static_BACKUP_dash_html.file | 212 | 0 | 212 |
| backend_static_demo_html.file | 201 | 0 | 201 |
| backend_static_dashboard_html.file | 187 | 0 | 187 |
| backend_static_example_html.file | 168 | 0 | 168 |
| backend_static_sample_html.file | 158 | 0 | 158 |
| backend__main__PathRegistry__path | 116 | 116 | 0 |
| backend__main__search | 111 | 53 | 58 |
| url.link | 67 | 67 | 0 |
| backend__features__core__helpers__artifact_root_for_output | 62 | 62 | 0 |
| backend.main.search | 56 | 2 | 54 |
| js.togglePanel | 54 | 54 | 0 |
| backend__main__repo_output_dir | 49 | 47 | 2 |
| backend.main.repo_output_dir | 48 | 47 | 1 |
| backend_static_experiment_html.inline_script | 45 | 0 | 45 |
| backend__main | 44 | 0 | 44 |
| backend__main__build_javascript_tree_sitter_callgraphX__walk | 44 | 39 | 5 |
| backend__main__build_tree_sitter_java_callgraphX__walk | 44 | 39 | 5 |
| js.renderInlineMarkdown | 43 | 0 | 43 |
| backend__main__cached_analyze_results | 42 | 3 | 39 |
| backend_static_dashboard_html.inline_script | 42 | 0 | 42 |
| backend_static_demo_html.inline_script | 42 | 0 | 42 |
| backend_static_example_html.inline_script | 42 | 0 | 42 |
| backend_static_sample_html.inline_script | 42 | 0 | 42 |
| backend__main__callgraphX_nodeXs_for_mapping__walk | 40 | 39 | 1 |
| backend__main__extract_json_text_values__walk | 40 | 39 | 1 |
| backend__main__run_analyze_job | 39 | 3 | 36 |
| backend__main__search_scim_dataset | 35 | 4 | 31 |
| backend.main.cached_analyze_results | 34 | 3 | 31 |

## complex_functions
Evidence: callgraph out-degree count only. Higher out-degree means the node calls more extracted targets.
| Node | Out-degree | In-degree | Total degree |
| --- | --- | --- | --- |
| backend_static_experiment_html.file | 330 | 0 | 330 |
| backend_static_BACKUP_dashboardv1_html.file | 215 | 0 | 215 |
| backend_static_BACKUP_dash_html.file | 212 | 0 | 212 |
| backend_static_demo_html.file | 201 | 0 | 201 |
| backend_static_dashboard_html.file | 187 | 0 | 187 |
| backend_static_example_html.file | 168 | 0 | 168 |
| backend_static_sample_html.file | 158 | 0 | 158 |
| backend__main__search | 58 | 53 | 111 |
| backend.main.search | 54 | 2 | 56 |
| backend_static_experiment_html.inline_script | 45 | 0 | 45 |
| backend__main | 44 | 0 | 44 |
| js.renderInlineMarkdown | 43 | 0 | 43 |
| backend_static_dashboard_html.inline_script | 42 | 0 | 42 |
| backend_static_demo_html.inline_script | 42 | 0 | 42 |
| backend_static_example_html.inline_script | 42 | 0 | 42 |
| backend_static_sample_html.inline_script | 42 | 0 | 42 |
| backend__main__cached_analyze_results | 39 | 3 | 42 |
| backend__main__run_analyze_job | 36 | 3 | 39 |
| backend_static_BACKUP_dash_html.inline_script | 33 | 0 | 33 |
| backend_static_BACKUP_dashboardv1_html.inline_script | 33 | 0 | 33 |
| backend_static_api_codeval_html.file | 33 | 0 | 33 |
| backend.main.cached_analyze_results | 31 | 3 | 34 |
| backend__main__search_scim_dataset | 31 | 4 | 35 |
| backend__main__analyze_repo | 30 | 0 | 30 |
| backend.main.run_analyze_job | 29 | 0 | 29 |
| backend__main__build_static_quality_signals | 29 | 1 | 30 |
| backend__main__summary | 28 | 2 | 30 |
| backend.main.build_static_quality_signals | 27 | 1 | 28 |
| backend.main.search_scim_dataset | 27 | 4 | 31 |
| backend__main__build_code_md_artifact | 26 | 2 | 28 |

## file_dependencies
Evidence: direct file graph edges from the file graph artifact.
| Source file | Target file | Evidence reason |
| --- | --- | --- |
| backend/features/feature_detection/feature_detection.py | backend/scim.py | function call, inferred call |
| backend/main.py | backend/features/feature_detection/ui/html_extractor.py | function call, inferred call |
| backend/main.py | backend/scim.py | function call, inferred call |
| backend/main.py | backend/supabase_client.py | function call, inferred call |
| backend/static/BACKUP/dash.html | backend/main.py | fetch/API |
| backend/static/BACKUP/dash.html | backend/static/autotrack.js | script src: /static/autotrack.js, inferred call |
| backend/static/BACKUP/dash.html | backend/static/dashboard.html | event handler, onclick handler, inferred call |
| backend/static/BACKUP/dash.html | backend/static/demo.html | onclick handler, inferred call |
| backend/static/BACKUP/dash.html | backend/static/experiment.html | onclick handler, inferred call |
| backend/static/BACKUP/dash.html | openapi.json | link href: /openapi.json, inferred call |
| backend/static/BACKUP/dashboardv1.html | backend/main.py | fetch/API |
| backend/static/BACKUP/dashboardv1.html | backend/static/autotrack.js | script src: /static/autotrack.js, inferred call |
| backend/static/BACKUP/dashboardv1.html | backend/static/dashboard.html | onclick handler, event handler, inferred call |
| backend/static/BACKUP/dashboardv1.html | backend/static/demo.html | onclick handler, inferred call |
| backend/static/BACKUP/dashboardv1.html | backend/static/experiment.html | onclick handler, inferred call |
| backend/static/BACKUP/dashboardv1.html | openapi.json | link href: /openapi.json, inferred call |
| backend/static/BACKUP/indexMAIN.html | backend/main.py | fetch/API |
| backend/static/BACKUP/indexMAIN.html | backend/static/autotrack.js | script src: /static/autotrack.js, inferred call |
| backend/static/api.codemd.html | backend/main.py | fetch/API |
| backend/static/api.codeval.html | backend/main.py | fetch/API |
| backend/static/api.codeval.html | backend/static/api.codemd.html | onclick handler, event handler, inferred call |
| backend/static/autotrack.js | backend/static/mixpanel.js | function call, inferred call |
| backend/static/autotrack_mixpanel.js | backend/static/mixpanel.js | function call, inferred call |
| backend/static/dashboard.html | backend/main.py | fetch/API |
| backend/static/dashboard.html | backend/static/autotrack.js | script src: /static/autotrack.js, inferred call |
| backend/static/dashboard.html | backend/static/mixpanel.js | script src: /static/mixpanel.js, inferred call |
| backend/static/demo.html | backend/main.py | fetch/API |
| backend/static/demo.html | backend/static/autotrack.js | script src: /static/autotrack.js, inferred call |
| backend/static/demo.html | backend/static/dashboard.html | onclick handler, event handler, inferred call |
| backend/static/demo.html | backend/static/mixpanel.js | script src: /static/mixpanel.js, inferred call |
| backend/static/example.html | backend/main.py | fetch/API |
| backend/static/example.html | backend/static/autotrack.js | script src: /static/autotrack.js, inferred call |
| backend/static/example.html | backend/static/dashboard.html | onclick handler, event handler, inferred call |
| backend/static/example.html | backend/static/demo.html | onclick handler, inferred call |
| backend/static/example.html | backend/static/mixpanel.js | script src: /static/mixpanel.js, inferred call |
| backend/static/experiment.html | backend/main.py | fetch/API |
| backend/static/experiment.html | backend/static/autotrack.js | script src: /static/autotrack.js, inferred call |
| backend/static/experiment.html | backend/static/dashboard.html | event handler, onclick handler, inferred call |
| backend/static/experiment.html | backend/static/demo.html | onclick handler, inferred call |
| backend/static/experiment.html | backend/static/example.html | onclick handler, inferred call |
| backend/static/experiment.html | backend/static/mixpanel-integration.js | script src: /static/mixpanel-integration.js, inferred call |
| backend/static/experiment.html | backend/static/mixpanel.js | script src: /static/mixpanel.js, inferred call |
| backend/static/experiment.html | openapi.json | link href: /openapi.json, inferred call |
| backend/static/mixpanel-integration.js | backend/main.py | fetch/API |
| backend/static/sample.html | backend/main.py | fetch/API |
| backend/static/sample.html | backend/static/autotrack.js | script src: /static/autotrack.js, inferred call |
| backend/static/sample.html | backend/static/dashboard.html | onclick handler, event handler, inferred call |
| backend/static/sample.html | backend/static/demo.html | onclick handler, inferred call |
| backend/static/sample.html | backend/static/mixpanel.js | script src: /static/mixpanel.js, inferred call |
| scripts/local-analyze.py | backend/main.py | function call, inferred call |

## core_files
Evidence: file graph degree count only.
| File | Total degree | In-degree | Out-degree |
| --- | --- | --- | --- |
| backend/main.py | 15 | 12 | 3 |
| backend/static/experiment.html | 10 | 2 | 8 |
| backend/static/autotrack.js | 9 | 8 | 1 |
| backend/static/dashboard.html | 9 | 6 | 3 |
| backend/static/demo.html | 9 | 5 | 4 |
| backend/static/mixpanel.js | 7 | 7 | 0 |
| backend/static/BACKUP/dash.html | 6 | 0 | 6 |
| backend/static/BACKUP/dashboardv1.html | 6 | 0 | 6 |
| backend/static/example.html | 6 | 1 | 5 |
| backend/static/sample.html | 5 | 0 | 5 |
| openapi.json | 3 | 3 | 0 |
| backend/scim.py | 2 | 2 | 0 |
| backend/static/BACKUP/indexMAIN.html | 2 | 0 | 2 |
| backend/static/api.codemd.html | 2 | 1 | 1 |
| backend/static/api.codeval.html | 2 | 0 | 2 |
| backend/static/mixpanel-integration.js | 2 | 1 | 1 |
| backend/features/feature_detection/feature_detection.py | 1 | 0 | 1 |
| backend/features/feature_detection/ui/html_extractor.py | 1 | 1 | 0 |
| backend/static/autotrack_mixpanel.js | 1 | 0 | 1 |
| backend/supabase_client.py | 1 | 1 | 0 |
| scripts/local-analyze.py | 1 | 0 | 1 |

## database_writes
Evidence: actual source matches to `table/from/collection` write operations, plus caller count for the enclosing Python callgraph function when available. No name-only matching is used.
_No rows found from the available direct evidence._

## external_calls
Evidence: direct Python/JavaScript/TypeScript import detection, excluding stdlib and local top-level modules.
_No rows found from the available direct evidence._

## ui_interactions
Evidence: direct HTML/UI element extraction from the HTML UI graph artifact.
| File | Line | Tag | Attributes |
| --- | --- | --- | --- |
| backend/static/BACKUP/dash.html | 26 | link | {"type": "image/svg+xml", "href": "/static/favicon.svg"} |
| backend/static/BACKUP/dash.html | 1556 | button | {"id": "sidebarToggle", "type": "button", "text": "‹"} |
| backend/static/BACKUP/dash.html | 1559 | a | {"text": "🏠 Home", "href": "#repository-dashboard"} |
| backend/static/BACKUP/dash.html | 1562 | a | {"text": "📊 Snapshot", "href": "#dashboard-metrics"} |
| backend/static/BACKUP/dash.html | 1563 | a | {"text": "🔄 Recent Changes", "href": "#github-daily-sync"} |
| backend/static/BACKUP/dash.html | 1564 | a | {"text": "🗺 Code Map", "href": "#graph-overview"} |
| backend/static/BACKUP/dash.html | 1565 | a | {"text": "Static Checks", "href": "#static-quality-signals"} |
| backend/static/BACKUP/dash.html | 1566 | a | {"text": "👥 User Activity", "href": "#setup-workflow"} |
| backend/static/BACKUP/dash.html | 1569 | a | {"text": "🔍 Search Graphs", "href": "#search-graphs-panel"} |
| backend/static/BACKUP/dash.html | 1570 | a | {"text": "💬 Ask CodeVal", "href": "#search-model"} |
| backend/static/BACKUP/dash.html | 1571 | a | {"text": "🔧 Suggested Fixes", "href": "#self-healing-panel"} |
| backend/static/BACKUP/dash.html | 1572 | a | {"text": "📁 Generated Files", "href": "#generated-files-panel"} |
| backend/static/BACKUP/dash.html | 1575 | a | {"text": "⚙️ Connect Your Product", "href": "#setup-workflow"} |
| backend/static/BACKUP/dash.html | 1576 | a | {"text": "Analytics Connect", "href": "#analytics-setup-panel"} |
| backend/static/BACKUP/dash.html | 1577 | a | {"text": "API", "href": "#developer-api-panel"} |
| backend/static/BACKUP/dash.html | 1578 | a | {"text": "✉️ Feedback", "href": "#feedback-panel"} |
| backend/static/BACKUP/dash.html | 1588 | a | {"text": "Get started", "href": "#setup-workflow"} |
| backend/static/BACKUP/dash.html | 1589 | button | {"text": "Export"} |
| backend/static/BACKUP/dash.html | 1603 | input | {"id": "repoUrl", "text": "https://github.com/username/repo"} |
| backend/static/BACKUP/dash.html | 1604 | button | {"id": "analyzeRepoButton", "text": "Analyze URL"} |
| backend/static/BACKUP/dash.html | 1610 | input | {"id": "codeUpload", "type": "file"} |
| backend/static/BACKUP/dash.html | 1611 | button | {"id": "analyzeUploadButton", "text": "Analyze Upload"} |
| backend/static/BACKUP/dash.html | 1638 | select | {"id": "dashboardGithubRepoSelect"} |
| backend/static/BACKUP/dash.html | 1642 | a | {"id": "dashboardGithubReconnectButton", "text": "Connect / switch account", "href": "/github/reconnect?next=/dashboard%23setup-workflow"} |
| backend/static/BACKUP/dash.html | 1643 | a | {"text": "Install app", "href": "https://github.com/apps/codevalaiapp/installations/new"} |
| backend/static/BACKUP/dash.html | 1644 | button | {"id": "dashboardGithubAnalyzeButton", "type": "button", "text": "Analyze selected product"} |
| backend/static/BACKUP/dash.html | 1659 | select | {"id": "dashboardGaPropertySelect"} |
| backend/static/BACKUP/dash.html | 1663 | a | {"id": "dashboardGaLoginButton", "text": "Connect analytics", "href": "/google-analytics/login?next=/dashboard%23analytics-setup-panel"} |
| backend/static/BACKUP/dash.html | 1664 | a | {"id": "dashboardGaReconnectButton", "text": "Reconnect analytics", "href": "/google-analytics/reconnect?next=/dashboard%23analytics-setup-panel"} |
| backend/static/BACKUP/dash.html | 1665 | select | {"id": "dashboardGaRangeSelect", "text": "Choose how much analytics history to load"} |
| backend/static/BACKUP/dash.html | 1670 | button | {"id": "dashboardGaRegisterDimensionsButton", "type": "button", "text": "Set up activity tracking"} |
| backend/static/BACKUP/dash.html | 1671 | button | {"id": "dashboardGaFetchButton", "type": "button", "text": "Load user activity"} |
| backend/static/BACKUP/dash.html | 1701 | button | {"id": "topFunctionSummariesRefreshButton", "type": "button", "text": "Refresh"} |
| backend/static/BACKUP/dash.html | 1727 | a | {"text": "Open API Docs", "href": "/api"} |
| backend/static/BACKUP/dash.html | 1728 | a | {"text": "Open schema", "href": "/openapi.json"} |
| backend/static/BACKUP/dash.html | 1752 | select | {"id": "dailyChangeDays", "text": "Choose recent commit window"} |
| backend/static/BACKUP/dash.html | 1757 | button | {"id": "dailyChangeButton", "type": "button", "text": "Load recent changes"} |
| backend/static/BACKUP/dash.html | 1763 | a | {"id": "dailyChangeOpenLink", "text": "Open change map", "href": "#"} |
| backend/static/BACKUP/dash.html | 1769 | button | {"type": "button"} |
| backend/static/BACKUP/dash.html | 1773 | button | {"id": "dailySummarySendButton", "type": "button", "text": "Generate summary"} |
| backend/static/BACKUP/dash.html | 1797 | a | {"id": "fileGraphOpenLink", "text": "Open file map", "href": "#"} |
| backend/static/BACKUP/dash.html | 1813 | a | {"id": "graphOpenLink", "text": "Open function callgraph", "href": "#"} |
| backend/static/BACKUP/dash.html | 1823 | a | {"id": "gaGraphOpenLink", "text": "Open user journey", "href": "#"} |
| backend/static/BACKUP/dash.html | 1824 | a | {"id": "gaMappedGraphOpenLink", "text": "Open code mapping", "href": "#"} |
| backend/static/BACKUP/dash.html | 1825 | a | {"id": "gaEventCallgraphMapOpenLink", "text": "Open event-to-code map", "href": "#"} |
| backend/static/BACKUP/dash.html | 1826 | a | {"id": "gaNavigatableGraphOpenLink", "text": "Explore user journey", "href": "#"} |
| backend/static/BACKUP/dash.html | 1836 | a | {"id": "gaSelectedEventGraphOpenLink", "text": "Open selected activity graph", "href": "#"} |
| backend/static/BACKUP/dash.html | 1860 | button | {"type": "button"} |
| backend/static/BACKUP/dash.html | 1879 | button | {"id": "selfHealingAnalyzeButton", "type": "button", "text": "Suggest a fix"} |
| backend/static/BACKUP/dash.html | 1898 | select | {"id": "graphDepthSelect", "text": "Choose how many caller/callee levels to show around search results"} |
| backend/static/BACKUP/dash.html | 1906 | a | {"id": "searchGraphOpenLink", "text": "Open search map", "href": "#"} |
| backend/static/BACKUP/dash.html | 1915 | select | {"id": "scopedCallgraphFileSelect"} |
| backend/static/BACKUP/dash.html | 1918 | select | {"id": "scopedCallgraphFunctionSelect"} |
| backend/static/BACKUP/dash.html | 1921 | select | {"id": "scopedCallgraphDepthSelect", "text": "Choose function graph depth"} |
| backend/static/BACKUP/dash.html | 1927 | button | {"type": "button", "text": "Show callgraph"} |
| backend/static/BACKUP/dash.html | 1928 | a | {"id": "scopedCallgraphOpenLink", "text": "Open scoped callgraph", "href": "#"} |
| backend/static/BACKUP/dash.html | 1943 | select | {"id": "modelQuestionSelect"} |
| backend/static/BACKUP/dash.html | 2046 | input | {"id": "modelSearchBox", "text": "Ask about features, user actions, errors, or code areas"} |
| backend/static/BACKUP/dash.html | 2069 | button | {"text": "Search"} |
| backend/static/BACKUP/dash.html | 2076 | button | {"type": "button"} |
| backend/static/BACKUP/dash.html | 2080 | button | {"text": "Generate answer"} |
| backend/static/BACKUP/dash.html | 2090 | button | {"type": "button"} |
| backend/static/BACKUP/dash.html | 2098 | button | {"type": "button"} |
| backend/static/BACKUP/dash.html | 2106 | button | {"type": "button"} |
| backend/static/BACKUP/dash.html | 2120 | button | {"text": "Save Product Details"} |
| backend/static/BACKUP/dash.html | 2121 | button | {"text": "Generate Product Description"} |
| backend/static/BACKUP/dash.html | 2125 | input | {"id": "productNameInput", "text": "Product name"} |
| backend/static/BACKUP/dash.html | 2126 | textarea | {"id": "productDescriptionInput", "text": "Product description. You can edit this before or after generating with the LLM."} |
| backend/static/BACKUP/dash.html | 2142 | a | {"id": "featureGraphOpenLink", "text": "Open feature implementation graph", "href": "#"} |
| backend/static/BACKUP/dash.html | 2151 | button | {"type": "button", "text": "Add Feature"} |
| backend/static/BACKUP/dash.html | 2152 | button | {"text": "Save Feature Names and Descriptions"} |
| backend/static/BACKUP/dash.html | 2157 | textarea | {"id": "featureGuidance", "text": "Optional: tell CodeVal how you want features named or grouped. Example: group admin flows separately from user-facing flows."} |
| backend/static/BACKUP/dash.html | 2158 | button | {"text": "Get Current Feature Completeness Description"} |
| backend/static/BACKUP/dash.html | 2178 | button | {"type": "button"} |
| backend/static/BACKUP/dash.html | 2188 | button | {"type": "button"} |
| backend/static/BACKUP/dash.html | 2205 | button | {"type": "button"} |
| backend/static/BACKUP/dash.html | 2220 | select | {"id": "todoScopeSelect"} |
| backend/static/BACKUP/dash.html | 2225 | select | {"id": "todoFileSelect"} |
| backend/static/BACKUP/dash.html | 2229 | select | {"id": "todoFunctionSelect"} |
| backend/static/BACKUP/dash.html | 2232 | textarea | {"id": "todoText", "text": "Add a TODO for the product, a file, or a specific function"} |
| backend/static/BACKUP/dash.html | 2233 | button | {"text": "Add TODO"} |
| backend/static/BACKUP/dash.html | 2275 | input | {"id": "codeNoteSearchBox", "text": "Search code to attach a note"} |
| backend/static/BACKUP/dash.html | 2276 | button | {"text": "Find"} |
| backend/static/BACKUP/dash.html | 2279 | textarea | {"id": "codeNoteText", "text": "Write a note about this code"} |
| backend/static/BACKUP/dash.html | 2280 | button | {"text": "Add Note to Code Comments"} |
| backend/static/BACKUP/dash.html | 2303 | input | {"id": "feedbackName", "text": "Name optional"} |
| backend/static/BACKUP/dash.html | 2304 | input | {"id": "feedbackEmail", "type": "email", "text": "Email optional"} |
| backend/static/BACKUP/dash.html | 2305 | textarea | {"id": "feedbackMessage", "text": "Tell us what is broken, confusing, or useful."} |
| backend/static/BACKUP/dash.html | 2306 | button | {"text": "Send Feedback"} |
| backend/static/BACKUP/dashboardv1.html | 26 | link | {"type": "image/svg+xml", "href": "/static/favicon.svg"} |
| backend/static/BACKUP/dashboardv1.html | 1595 | button | {"id": "sidebarToggle", "type": "button", "text": "‹"} |
| backend/static/BACKUP/dashboardv1.html | 1598 | a | {"text": "🏠 Home", "href": "#repository-dashboard"} |
| backend/static/BACKUP/dashboardv1.html | 1601 | a | {"text": "📊 Snapshot", "href": "#dashboard-metrics"} |
| backend/static/BACKUP/dashboardv1.html | 1602 | a | {"text": "🔄 Recent Changes", "href": "#github-daily-sync"} |
| backend/static/BACKUP/dashboardv1.html | 1603 | a | {"text": "🗺 Code Map", "href": "#graph-overview"} |
| backend/static/BACKUP/dashboardv1.html | 1604 | a | {"text": "Static Checks", "href": "#static-quality-signals"} |
| backend/static/BACKUP/dashboardv1.html | 1605 | a | {"text": "👥 User Activity", "href": "#setup-workflow"} |
| backend/static/BACKUP/dashboardv1.html | 1608 | a | {"text": "🔍 Search Graphs", "href": "#search-graphs-panel"} |
| backend/static/BACKUP/dashboardv1.html | 1609 | a | {"text": "💬 Ask CodeVal", "href": "#search-model"} |
| backend/static/BACKUP/dashboardv1.html | 1610 | a | {"text": "🔧 Suggested Fixes", "href": "#self-healing-panel"} |

## known_todos
Evidence: literal TODO/FIXME-style comment extraction from repo comments.
| File | Line | Tag | Text |
| --- | --- | --- | --- |
| backend/main.py | 150 | TODO | Fix joern callgrah - fix render environment JOERN_BIN=/path/to/joern |
| backend/main.py | 151 | TODO | Will need to install joern on render |
| backend/main.py | 154 | TODO | Function |
| backend/main.py | 156 | TODO | section can you allow the user to add a TODO. |
| backend/main.py | 157 | TODO | at the Product Level. |
| backend/main.py | 158 | TODO | . |
| backend/main.py | 160 | TODO | at the function level |
| backend/main.py | 162 | TODO | you simply the relevant functions, text and |
| backend/main.py | 12588 | TODO | "], |
| backend/main.py | 28213 | TODO | TODO |
| backend/main.py | 28260 | TODO | uncomment this - testing only |
| backend/main.py | 28335 | TODO | remove this - testing only |
| backend/main.py | 34210 | TODO | /FIXME-style comment extraction from repo comments.", md_table(["File", "Line", "Tag", "Text"], todo_rows), |
| backend/scim.py | 2744 | TODO | Show neighors for a node only when the user clicks on the node. |
| backend/parsers/python/python_analyzer.py | 271 | TODO | Added new entry point main.py? |
| backend/static/dashboard.html | 3232 | TODO | Add the feature related questions back later on |
| backend/static/demo.html | 2595 | TODO | </span></a> |
| backend/static/demo.html | 3024 | TODO | Add the feature related questions back later on |
| backend/static/example.html | 1950 | TODO | </a> |
| backend/static/example.html | 2346 | TODO | Add the feature related questions back later on |
| backend/static/experiment.html | 1870 | TODO | </a> |
| backend/static/experiment.html | 2677 | TODO | Add the feature related questions back later on |
| backend/static/sample.html | 1950 | TODO | </a> |
| backend/static/sample.html | 2325 | TODO | Add the feature related questions back later on |
| backend/static/BACKUP/dash.html | 1935 | TODO | Add the feature related questions back later on |
| backend/static/BACKUP/dashboardv1.html | 1980 | TODO | Add the feature related questions back later on |
| backend/static/BACKUP/indexMAIN.html | 969 | TODO | TODO |

## recently_changed
Evidence: local `git log` when a `.git` directory is available; otherwise concrete GitHub commit payload from analysis if present.
_No rows found from the available direct evidence._

## high_churn_files
Evidence: file occurrence/change count from local git history when available; otherwise concrete GitHub changed-file payload from analysis if present.
_No rows found from the available direct evidence._

## stable_files
Evidence: tracked files with zero touches in the latest 100 local git commits. Empty when no local `.git` evidence is available.
_No rows found from the available direct evidence._
