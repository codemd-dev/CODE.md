# code.md
Machine-generated structural truth for this repository.
Used by coding agents to understand architecture, flow, and dependencies.

Generated for local-path/vscode-extension-graphs-9002d610 from direct repository evidence only. No LLM summaries, feature catalog, embeddings, vectors, train pairs, or model-layer files are used.
Only deterministic sections requested by the user are included.

## api_routes
Evidence: deterministic Python decorator parsing plus exact JavaScript/TypeScript route-call parsing from source files.
| Method | Path | Handler | File | Line |
| --- | --- | --- | --- | --- |
| POST | /test-suite/generate | test_suite_generate | backend/main.py | 1436 |
| GET | / | root | backend/main.py | 4152 |
| GET | /index.html | index_alias | backend/main.py | 4156 |
| GET | /favicon.ico | favicon | backend/main.py | 4161 |
| GET | /robots.txt | robots_txt | backend/main.py | 4166 |
| GET | /sitemap.xml | sitemap_xml | backend/main.py | 4178 |
| GET,HEAD | /dashboard | dashboard | backend/main.py | 4199 |
| GET,HEAD | /dashboard.html | dashboard | backend/main.py | 4200 |
| GET,HEAD | /dashboard.xml | dashboard | backend/main.py | 4201 |
| GET | /sample.html | sample_page | backend/main.py | 4205 |
| GET | /sample | sample_page | backend/main.py | 4206 |
| GET | /demo.html | demo_page | backend/main.py | 4210 |
| GET | /demo | demo_page | backend/main.py | 4211 |
| GET | /api | api_docs | backend/main.py | 4218 |
| GET | /api.html | api_docs | backend/main.py | 4219 |
| GET | /artifact/render | render_external_html_artifact | backend/main.py | 4224 |
| GET | /debug/output/{repo}/{folder}/{filename} | debug_output_file | backend/main.py | 4252 |
| GET | /debug/output-files | debug_output_files | backend/main.py | 4287 |
| GET | /files | list_output_zips | backend/main.py | 4305 |
| GET | /output-zips | list_output_zips | backend/main.py | 4306 |
| GET | /zip_files | list_output_zips | backend/main.py | 4307 |
| POST | /github/webhook | github_webhook | backend/main.py | 4316 |
| GET | /github/login | github_login | backend/main.py | 4333 |
| GET | /github/reconnect | github_reconnect | backend/main.py | 4366 |
| GET | /debug/github-oauth | debug_github_oauth | backend/main.py | 4389 |
| GET | /github/callback | github_callback | backend/main.py | 4409 |
| GET | /github/me | github_me | backend/main.py | 4492 |
| POST | /github/logout | github_logout | backend/main.py | 4502 |
| GET | /github/repos | github_repos | backend/main.py | 4513 |
| GET | /github/saved-analyses | github_saved_analyses | backend/main.py | 4579 |
| GET | /github/saved-analyses/latest | github_latest_saved_analysis | backend/main.py | 4615 |
| GET | /sample-analysis | sample_analysis | backend/main.py | 4679 |
| GET | /github/daily-commits | github_daily_commits | backend/main.py | 4837 |
| GET | /github/daily-commit-graph | github_daily_commit_graph | backend/main.py | 4844 |
| GET | /github/daily-change-graph | github_daily_change_graph | backend/main.py | 6075 |
| GET | /github/daily-summary-prompt | github_daily_summary_prompt | backend/main.py | 6090 |
| POST | /github/daily-summary | github_daily_summary | backend/main.py | 6106 |
| POST | /github/analyze | github_analyze_selected | backend/main.py | 6141 |
| GET | /google-analytics/login | google_analytics_login | backend/main.py | 6193 |
| GET | /google-analytics/reconnect | google_analytics_reconnect | backend/main.py | 6226 |
| GET | /debug/google-analytics-oauth | debug_google_analytics_oauth | backend/main.py | 6242 |
| GET | /google-analytics/callback | google_analytics_callback | backend/main.py | 6255 |
| GET | /google-analytics/me | google_analytics_me | backend/main.py | 6325 |
| POST | /google-analytics/logout | google_analytics_logout | backend/main.py | 6335 |
| GET | /google-analytics/properties | google_analytics_properties | backend/main.py | 6346 |
| POST | /google-analytics/register-error-dimensions | google_analytics_register_error_dimensions | backend/main.py | 6354 |
| POST | /mixpanel/connect | mixpanel_connect | backend/main.py | 9799 |
| GET | /mixpanel/connection-status | mixpanel_connection_status | backend/main.py | 9856 |
| POST | /mixpanel/load-user-activity | mixpanel_load_user_activity | backend/main.py | 9986 |
| POST | /sentry/connect | sentry_connect | backend/main.py | 10117 |
| POST | /sentry/load-errors | sentry_load_errors | backend/main.py | 10224 |
| POST | /analytics/map-activity-to-code | analytics_map_activity_to_code | backend/main.py | 10344 |
| GET | /self-healing/ga-errors | self_healing_ga_errors | backend/main.py | 11711 |
| POST | /self-healing/analyze | self_healing_analyze | backend/main.py | 11727 |
| POST | /self-healing/evaluate | self_healing_evaluate | backend/main.py | 11795 |
| POST | /self-healing/apply | self_healing_apply | backend/main.py | 11844 |
| POST | /google-analytics/rebuild-event-traces | google_analytics_rebuild_event_traces | backend/main.py | 12105 |
| POST | /google-analytics/event-callgraph | google_analytics_event_callgraph | backend/main.py | 12110 |
| POST | /mixpanel/event-callgraph | mixpanel_event_callgraph | backend/main.py | 12118 |
| GET | /google-analytics/callgraph-events | google_analytics_callgraph_events | backend/main.py | 12126 |
| POST | /contact | contact | backend/main.py | 12582 |
| POST | /code-notes | add_code_note | backend/main.py | 12616 |
| GET | /todo-targets | todo_targets | backend/main.py | 12815 |
| POST | /user-todos | add_user_todo | backend/main.py | 12900 |
| GET | /user-todos | list_user_todos | backend/main.py | 12999 |
| POST | /user-todos/delete | delete_user_todo | backend/main.py | 13043 |
| POST | /scoped-callgraph | scoped_callgraph | backend/main.py | 13080 |
| GET | /quality-signals | quality_signals | backend/main.py | 15824 |
| POST | /quality-signals/validate | validate_quality_signal | backend/main.py | 16230 |
| POST | /quality-signals/analyze | analyze_quality_signal | backend/main.py | 16297 |
| POST | /quality-signals/evaluate | evaluate_quality_signal_fix | backend/main.py | 16392 |
| POST | /quality-signals/apply | apply_quality_signal_fix | backend/main.py | 16441 |
| POST | /quality-signals/resolve | resolve_quality_signal | backend/main.py | 16462 |
| GET | /unused-functions | list_unused_functions | backend/main.py | 16527 |
| POST | /unused-functions/ack | ack_unused_functions | backend/main.py | 16590 |
| POST | /search | search | backend/main.py | 25376 |
| POST | /search-result-graph | search_result_graph | backend/main.py | 26393 |
| GET | /function-summaries | function_summaries | backend/main.py | 26482 |
| POST | /searchOLD | search | backend/main.py | 26501 |
| POST | /search-answer | search_answer | backend/main.py | 26813 |
| POST | /search-answer-feedback | search_answer_feedback | backend/main.py | 26884 |
| POST | /product-feature-metadata | product_feature_metadata | backend/main.py | 27645 |
| POST | /feature-summary | feature_summary | backend/main.py | 27698 |
| POST | /summary | summary | backend/main.py | 27899 |
| POST | /code-md | code_md_endpoint | backend/main.py | 33972 |
| POST | /analyze/start | analyze_start | backend/main.py | 35048 |
| POST | /playwright/start | playwright_start | backend/main.py | 35081 |
| GET | /playwright/status/{job_id} | playwright_status | backend/main.py | 35108 |
| GET | /analyze/status/{job_id} | analyze_status | backend/main.py | 35116 |
| POST | /analyze | analyze_repo | backend/main.py | 35191 |
| POST | /analyze/upload | analyze_upload | backend/main.py | 35315 |
| POST | /analyze/local_path | analyze_local_path | backend/main.py | 35405 |
| POST | /analyze/local_path/start | analyze_local_path_start | backend/main.py | 35449 |

## entry_points
Evidence: exact `entry_points` array from the selected callgraph artifact.
_No rows found from the available direct evidence._

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
| backend.main.search | 54 | 0 | 54 |
| js.togglePanel | 54 | 54 | 0 |
| backend__main__repo_output_dir | 49 | 47 | 2 |
| backend.main.repo_output_dir | 48 | 47 | 1 |
| backend_static_experiment_html.inline_script | 45 | 0 | 45 |
| backend__main | 44 | 0 | 44 |
| backend__main__build_javascript_tree_sitter_callgraphX__walk | 44 | 39 | 5 |
| backend__main__build_tree_sitter_java_callgraphX__walk | 44 | 39 | 5 |
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
| backend.main.supabase_execute | 34 | 34 | 0 |

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
| backend.main.search | 54 | 0 | 54 |
| backend_static_experiment_html.inline_script | 45 | 0 | 45 |
| backend__main | 44 | 0 | 44 |
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
| backend.scim.evidence_feature_candidates | 25 | 1 | 26 |

## file_dependencies
Evidence: direct file graph edges from the file graph artifact.
| Source file | Target file | Evidence reason |
| --- | --- | --- |
| backend/features/feature_detection/feature_detection.py | backend/scim.py | function call, inferred call |
| backend/main.py | backend/features/feature_detection/ui/html_extractor.py | function call, inferred call |
| backend/main.py | backend/scim.py | function call, inferred call |
| backend/main.py | backend/supabase_client.py | function call, inferred call |
| backend/static/BACKUP/dash.html | backend/static/autotrack.js | script src: /static/autotrack.js, inferred call |
| backend/static/BACKUP/dash.html | backend/static/dashboard.html | event handler, onclick handler, inferred call |
| backend/static/BACKUP/dash.html | backend/static/demo.html | onclick handler, inferred call |
| backend/static/BACKUP/dash.html | backend/static/experiment.html | onclick handler, inferred call |
| backend/static/BACKUP/dash.html | openapi.json | link href: /openapi.json, inferred call |
| backend/static/BACKUP/dashboardv1.html | backend/static/autotrack.js | script src: /static/autotrack.js, inferred call |
| backend/static/BACKUP/dashboardv1.html | backend/static/dashboard.html | onclick handler, event handler, inferred call |
| backend/static/BACKUP/dashboardv1.html | backend/static/demo.html | onclick handler, inferred call |
| backend/static/BACKUP/dashboardv1.html | backend/static/experiment.html | onclick handler, inferred call |
| backend/static/BACKUP/dashboardv1.html | openapi.json | link href: /openapi.json, inferred call |
| backend/static/BACKUP/indexMAIN.html | backend/static/autotrack.js | script src: /static/autotrack.js, inferred call |
| backend/static/api.codeval.html | backend/static/api.codemd.html | onclick handler, event handler, inferred call |
| backend/static/autotrack.js | backend/static/mixpanel.js | function call, inferred call |
| backend/static/autotrack_mixpanel.js | backend/static/mixpanel.js | function call, inferred call |
| backend/static/dashboard.html | backend/static/autotrack.js | script src: /static/autotrack.js, inferred call |
| backend/static/dashboard.html | backend/static/mixpanel.js | script src: /static/mixpanel.js, inferred call |
| backend/static/demo.html | backend/static/autotrack.js | script src: /static/autotrack.js, inferred call |
| backend/static/demo.html | backend/static/dashboard.html | event handler, onclick handler, inferred call |
| backend/static/demo.html | backend/static/mixpanel.js | script src: /static/mixpanel.js, inferred call |
| backend/static/example.html | backend/static/autotrack.js | script src: /static/autotrack.js, inferred call |
| backend/static/example.html | backend/static/dashboard.html | event handler, onclick handler, inferred call |
| backend/static/example.html | backend/static/demo.html | onclick handler, inferred call |
| backend/static/example.html | backend/static/mixpanel.js | script src: /static/mixpanel.js, inferred call |
| backend/static/experiment.html | backend/static/autotrack.js | script src: /static/autotrack.js, inferred call |
| backend/static/experiment.html | backend/static/dashboard.html | onclick handler, event handler, inferred call |
| backend/static/experiment.html | backend/static/demo.html | onclick handler, inferred call |
| backend/static/experiment.html | backend/static/example.html | onclick handler, inferred call |
| backend/static/experiment.html | backend/static/mixpanel-integration.js | script src: /static/mixpanel-integration.js, inferred call |
| backend/static/experiment.html | backend/static/mixpanel.js | script src: /static/mixpanel.js, inferred call |
| backend/static/experiment.html | openapi.json | link href: /openapi.json, inferred call |
| backend/static/sample.html | backend/static/autotrack.js | script src: /static/autotrack.js, inferred call |
| backend/static/sample.html | backend/static/dashboard.html | event handler, onclick handler, inferred call |
| backend/static/sample.html | backend/static/demo.html | onclick handler, inferred call |
| backend/static/sample.html | backend/static/mixpanel.js | script src: /static/mixpanel.js, inferred call |
| scripts/local-analyze.py | backend/main.py | function call, inferred call |

## core_files
Evidence: file graph degree count only.
| File | Total degree | In-degree | Out-degree |
| --- | --- | --- | --- |
| backend/static/autotrack.js | 9 | 8 | 1 |
| backend/static/experiment.html | 9 | 2 | 7 |
| backend/static/dashboard.html | 8 | 6 | 2 |
| backend/static/demo.html | 8 | 5 | 3 |
| backend/static/mixpanel.js | 7 | 7 | 0 |
| backend/static/BACKUP/dash.html | 5 | 0 | 5 |
| backend/static/BACKUP/dashboardv1.html | 5 | 0 | 5 |
| backend/static/example.html | 5 | 1 | 4 |
| backend/main.py | 4 | 1 | 3 |
| backend/static/sample.html | 4 | 0 | 4 |
| openapi.json | 3 | 3 | 0 |
| backend/scim.py | 2 | 2 | 0 |
| backend/features/feature_detection/feature_detection.py | 1 | 0 | 1 |
| backend/features/feature_detection/ui/html_extractor.py | 1 | 1 | 0 |
| backend/static/BACKUP/indexMAIN.html | 1 | 0 | 1 |
| backend/static/api.codemd.html | 1 | 1 | 0 |
| backend/static/api.codeval.html | 1 | 0 | 1 |
| backend/static/autotrack_mixpanel.js | 1 | 0 | 1 |
| backend/static/mixpanel-integration.js | 1 | 1 | 0 |
| backend/supabase_client.py | 1 | 1 | 0 |
| scripts/local-analyze.py | 1 | 0 | 1 |

## database_writes
Evidence: actual source matches to `table/from/collection` write operations, plus caller count for the enclosing Python callgraph function when available. No name-only matching is used.
| File | Line | Operation | Enclosing function | Caller count | Source line |
| --- | --- | --- | --- | --- | --- |
| backend/main.py | 2041 | insert | supabase_insert_row_with_schema_fallback | 1 | return client.table(table).insert(payload).execute() |
| backend/main.py | 2052 | insert | supabase_insert_row_with_schema_fallback | 1 | lambda: client.table(table).insert(fallback_payload).execute(), |
| backend/main.py | 2062 | update | supabase_update_row_with_schema_fallback | 3 | return client.table(table).update(attempted_payload).eq("id", row_id).execute() |
| backend/main.py | 2092 | update | supabase_update_row_with_schema_fallback | 3 | lambda: client.table(table).update(fallback_payload).eq("id", row_id).execute() |
| backend/main.py | 2108 | upsert | supabase_upsert_user_repo | 2 | lambda: client.table("codeval_github_users").upsert(user_payload, on_conflict="github_user_id").execute(), |
| backend/main.py | 2113 | upsert | supabase_upsert_user_repo | 2 | lambda: client.table("codeval_repositories").upsert(repo_payload, on_conflict="codeval_repo_key").execute(), |
| backend/main.py | 2177 | update | supabase_update_analysis_progress | 3 | lambda: client.table("codeval_analysis_runs").update({ |
| backend/main.py | 2195 | upsert | supabase_link_user_repository | 2 | lambda: client.table("codeval_user_repositories").upsert({ |
| backend/main.py | 2211 | update | supabase_mark_analysis_failed | 1 | lambda: client.table("codeval_analysis_runs").update({ |
| backend/main.py | 2269 | upsert | supabase_persist_static_quality_bugs | 1 | lambda: client.table("codeval_bugs").upsert( |
| backend/main.py | 2558 | upsert | supabase_persist_analysis_artifacts | 1 | lambda: client.table("codeval_artifacts").upsert( |
| backend/main.py | 2629 | update | saved_user_metadata_for_repo | 0 | preserved.update({key: value for key, value in summary_payload.items() if value not in (None, "", [])}) |
| backend/main.py | 3243 | upsert | supabase_persist_daily_commit_snapshots | 2 | .upsert(rows, on_conflict="repository_id,snapshot_date,commit_key,selected_sha") |
| backend/main.py | 3337 | upsert | supabase_upload_generated_artifacts_for_latest | 4 | lambda: client.table("codeval_artifacts").upsert( |
| backend/main.py | 3702 | update | supabase_restore_analysis_payload | 3 | payload.update(summary_payload) |
| backend/main.py | 9843 | upsert | mixpanel_connect | 0 | lambda: client.table("codeval_mixpanel_connections").upsert(row, on_conflict="owner_name,repo_name").execute(), |
| backend/main.py | 10156 | upsert | sentry_connect | 0 | lambda: client.table("codeval_sentry_connections").upsert(row, on_conflict="owner_name,repo_name").execute(), |
| backend/main.py | 10291 | upsert | sentry_load_errors | 0 | .upsert(rows, on_conflict="issue_id") |
| backend/main.py | 10403 | update | analytics_map_activity_to_code | 0 | .update({"mapped": True}) |
| backend/main.py | 12963 | insert | add_user_todo | 0 | lambda: client.table("codeval_todos").insert(todo_row).execute(), |
| backend/main.py | 13059 | delete | delete_user_todo | 0 | .delete() |
| backend/main.py | 16491 | update | resolve_quality_signal | 0 | .update(update_payload) |
| backend/main.py | 16508 | update | resolve_quality_signal | 0 | row[0].update(update_payload) |
| backend/main.py | 16512 | upsert | resolve_quality_signal | 0 | .upsert(row[0], on_conflict="analysis_run_id,finding_id") |
| backend/main.py | 34971 | update | run_analyze_job | 0 | results.update(dispatch_parsers( |
| backend/main.py | 34988 | update | run_analyze_job | 0 | results.update(build_scim_artifacts( |

## external_calls
Evidence: direct Python/JavaScript/TypeScript import detection, excluding stdlib and local top-level modules.
| Package/module | Import count | Examples |
| --- | --- | --- |
| fastapi | 9 | backend/main.py:55, backend/main.py:61, backend/main.py:64, backend/main.py:172, backend/main.py:173 |
| libcst | 8 | backend/main.py:84, backend/main.py:85, backend/main.py:90, backend/main.py:91, backend/main.py:92 |
| features | 5 | backend/main.py:94, backend/main.py:95, backend/main.py:96, backend/main.py:97, scripts/deletion-report.py:297 |
| networkx | 4 | backend/main.py:88, backend/parsers/python/pyan3_parser.py:3, backend/parsers/python/pycg_parser.py:3, backend/parsers/python/python_analyzer.py:6 |
| scim | 4 | backend/main.py:10580, backend/main.py:23484, backend/main.py:31037, backend/main.py:31150 |
| pyvis | 3 | backend/main.py:68, backend/main.py:19291, backend/main.py:19047 |
| pycg | 3 | backend/main.py:107, backend/parsers/python/pycg_parser.py:5, backend/parsers/python/pycg_parser.py:21 |
| fs | 3 | scripts/codemd-mcp-server.js:4, scripts/copy-backend.js:4, src/extension.ts:3 |
| path | 3 | scripts/codemd-mcp-server.js:5, scripts/copy-backend.js:5, src/extension.ts:2 |
| openai | 2 | backend/main.py:57, backend/main.py:58 |
| pydantic | 2 | backend/main.py:62, backend/main.py:170 |
| javalang | 2 | backend/main.py:72, backend/main.py:28698 |
| parsers | 2 | backend/main.py:113, backend/main.py:28456 |
| cryptography | 2 | backend/main.py:9739, backend/main.py:9744 |
| tree_sitter | 2 | backend/main.py:28959, backend/main.py:29444 |
| sentry_sdk | 2 | backend/main.py:485, backend/main.py:486 |
| supabase | 2 | backend/main.py:1896, backend/supabase_client.py:4 |
| numpy | 2 | backend/main.py:23483, backend/scim.py:41 |
| torch | 2 | backend/scim.py:54, backend/scim.py:55 |
| os | 2 | scripts/codemd-mcp-server.js:6, src/extension.ts:4 |
| child_process | 2 | scripts/codemd-mcp-server.js:7, src/extension.ts:6 |
| requests | 1 | backend/main.py:56 |
| playwright | 1 | backend/main.py:774 |
| tree_sitter_java | 1 | backend/main.py:28960 |
| tree_sitter_javascript | 1 | backend/main.py:29466 |
| supabase_client | 1 | backend/main.py:1878 |
| jwt | 1 | backend/main.py:4061 |
| tree_sitter_typescript | 1 | backend/main.py:29458 |
| pyparsing | 1 | backend/parsers/python/pyan3_parser.py:4 |
| pyan | 1 | backend/parsers/python/pyan3_parser.py:52 |
| faiss | 1 | backend/scim.py:44 |
| sentence_transformers | 1 | backend/scim.py:49 |
| sklearn | 1 | backend/scim.py:61 |
| main | 1 | scripts/local-analyze.py:114 |
| ${repoRoot} | 1 | scripts/copy-backend.js:92 |
| vscode | 1 | src/extension.ts:1 |
| crypto | 1 | src/extension.ts:5 |
| undici | 1 | src/extension.ts:7 |

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
| Commit | Date | Subject | Files |
| --- | --- | --- | --- |
| 590e455676 | 2026-07-13 09:06:22 -0700 | code mcp server | .codex/config.toml, .mcp.json, backend/features/core/helpers.py, backend/main.py, backend/trace_output.log, codeval-codemd-graphs-0.0.31.vsix, codeval-codemd-graphs-0.0.32.vsix, codeval-codemd-graphs-0.0.33.vsix ... |
| 313dff5269 | 2026-07-11 01:33:04 -0700 | Initial Commit | .codex/config.toml, .gitignore, .mcp.json, .vscodeignore, AGENTS.md, README.md, backend/features/core/constants.py, backend/features/core/helpers.py ... |

## high_churn_files
Evidence: file occurrence/change count from local git history when available; otherwise concrete GitHub changed-file payload from analysis if present.
| File | Commit touch/change count |
| --- | --- |
| .codex/config.toml | 2 |
| .mcp.json | 2 |
| backend/features/core/helpers.py | 2 |
| backend/main.py | 2 |
| codeval-codemd-graphs-0.0.31.vsix | 2 |
| debug.log | 2 |
| package-lock.json | 2 |
| package.json | 2 |
| scripts/codemd-mcp-server.js | 2 |
| scripts/copy-backend.js | 2 |
| scripts/deletion-report.py | 2 |
| scripts/local-analyze.py | 2 |
| src/extension.ts | 2 |
| backend/trace_output.log | 1 |
| codeval-codemd-graphs-0.0.32.vsix | 1 |
| codeval-codemd-graphs-0.0.33.vsix | 1 |
| codeval-codemd-graphs-0.0.34.vsix | 1 |
| codeval-codemd-graphs-0.0.35-test.vsix | 1 |
| codeval-codemd-graphs-0.0.35.vsix | 1 |
| codeval-codemd-graphs-0.0.36.vsix | 1 |
| codeval-codemd-graphs-0.0.37.vsix | 1 |
| codeval-codemd-graphs-0.0.38.vsix | 1 |
| codeval-codemd-graphs-0.0.39.vsix | 1 |
| codeval-codemd-graphs-0.0.40.vsix | 1 |
| .gitignore | 1 |
| .vscodeignore | 1 |
| AGENTS.md | 1 |
| README.md | 1 |
| backend/features/core/constants.py | 1 |
| backend/features/feature_detection/__init__.py | 1 |
| backend/features/feature_detection/feature_detection.py | 1 |
| backend/features/feature_detection/ga/interactions.py | 1 |
| backend/features/feature_detection/mapping/backend_mapper.py | 1 |
| backend/features/feature_detection/mapping/callgraph_mapper.py | 1 |
| backend/features/feature_detection/mapping/route_mapper.py | 1 |
| backend/features/feature_detection/scim/scim_builder.py | 1 |
| backend/features/feature_detection/ui/__init__.py | 1 |
| backend/features/feature_detection/ui/android_extractor.py | 1 |
| backend/features/feature_detection/ui/angular_extractor.py | 1 |
| backend/features/feature_detection/ui/html_extractor.py | 1 |

## stable_files
Evidence: tracked files with zero touches in the latest 100 local git commits. Empty when no local `.git` evidence is available.
_No rows found from the available direct evidence._
