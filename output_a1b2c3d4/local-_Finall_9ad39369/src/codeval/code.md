# code.md
Machine-generated structural truth for this repository.
Used by coding agents to understand architecture, flow, and dependencies.

Generated for local-upload/FinallyDoneApp-67da86d1 from direct repository evidence only. No LLM summaries, feature catalog, embeddings, vectors, train pairs, or model-layer files are used.
Only deterministic sections requested by the user are included.

## api_routes
Evidence: deterministic Python decorator parsing plus exact JavaScript/TypeScript route-call parsing from source files.
| Method | Path | Handler | File | Line |
| --- | --- | --- | --- | --- |
| GET | /taskschat.html | taskschat | tasksChat.py | 21 |
| GET | /privacy | privacy | tasksChat.py | 25 |
| GET | /privacy.html | privacy_html | tasksChat.py | 29 |
| GET | /terms | terms | tasksChat.py | 33 |
| GET | /terms.html | terms_html | tasksChat.py | 37 |
| GET | /oauth/start | oauth_start | tasksChat.py | 231 |
| GET | /oauth/google/callback | oauth_callback | tasksChat.py | 292 |
| POST | /oauth/token | oauth_token | tasksChat.py | 384 |
| GET | /debug/pending-states | debug_pending_states | tasksChat.py | 490 |
| GET | /list-task-lists | list_task_lists | tasksChat.py | 506 |
| GET | /list-tasks | list_tasks | tasksChat.py | 549 |
| POST | /create-task | create_task | tasksChat.py | 605 |
| POST | /update-task/{task_id} | update_task | tasksChat.py | 635 |
| POST | /complete-task/{task_id} | complete_task | tasksChat.py | 668 |
| POST | /uncomplete-task/{task_id} | uncomplete_task | tasksChat.py | 698 |

## entry_points
Evidence: exact `entry_points` array from the selected callgraph artifact.
| Node | Out-degree | In-degree |
| --- | --- | --- |
| api.complete-task_task_id | 1 | 0 |
| api.create-task | 1 | 1 |
| api.debug_pending-states | 1 | 0 |
| api.list-task-lists | 1 | 1 |
| api.list-tasks | 1 | 1 |
| api.oauth_google_callback | 1 | 0 |
| api.oauth_start | 1 | 0 |
| api.oauth_token | 1 | 0 |
| api.privacy | 1 | 0 |
| api.privacy.html | 1 | 0 |
| api.taskschat.html | 1 | 0 |
| api.terms | 1 | 0 |
| api.terms.html | 1 | 0 |
| api.uncomplete-task_task_id | 1 | 0 |
| api.update-task_task_id | 1 | 0 |
| tasksChat.complete_task | 0 | 1 |
| tasksChat.create_task | 0 | 1 |
| tasksChat.debug_pending_states | 1 | 1 |
| tasksChat.list_task_lists | 0 | 1 |
| tasksChat.list_tasks | 0 | 1 |
| tasksChat.oauth_callback | 3 | 1 |
| tasksChat.oauth_start | 2 | 1 |
| tasksChat.oauth_token | 1 | 1 |
| tasksChat.privacy | 0 | 1 |
| tasksChat.privacy_html | 0 | 1 |
| tasksChat.taskschat | 0 | 1 |
| tasksChat.terms | 0 | 1 |
| tasksChat.terms_html | 0 | 1 |
| tasksChat.uncomplete_task | 0 | 1 |
| tasksChat.update_task | 0 | 1 |

## risky_functions
Evidence: callgraph in-degree count only. Higher in-degree means more callers in the extracted graph.
| Node | In-degree | Out-degree | Total degree |
| --- | --- | --- | --- |
| tasksChat__get_google_token_for_request | 7 | 2 | 9 |
| tasksChat.now_ts | 6 | 0 | 6 |
| tasksChat__now_ts | 6 | 0 | 6 |
| tasksChat__get_current_user | 2 | 0 | 2 |
| url.https:_finallydoneapp.com_privacy | 2 | 0 | 2 |
| url.mailto:finallydoneapp_gmail.com | 2 | 0 | 2 |
| api.button | 1 | 0 | 1 |
| api.chatgpt.com_g_g-69e2d6e331308191bc127f2a960e867a | 1 | 0 | 1 |
| api.complete-task | 1 | 0 | 1 |
| api.create-task | 1 | 1 | 2 |
| api.delete-task | 1 | 0 | 1 |
| api.list-task-lists | 1 | 1 | 2 |
| api.list-tasks | 1 | 1 | 2 |
| api.span | 1 | 0 | 1 |
| api.star-task | 1 | 0 | 1 |
| api.td | 1 | 0 | 1 |
| api.uncomplete-task | 1 | 0 | 1 |
| js.addTask | 1 | 1 | 2 |
| js.login | 1 | 0 | 1 |
| js.openGPT | 1 | 0 | 1 |
| js.toggleCompleted | 1 | 0 | 1 |
| privacy_html.mailto:finallydoneapp_gmail.com | 1 | 1 | 2 |
| static_privacy_html.mailto:finallydoneapp_gmail.com | 1 | 1 | 2 |
| static_taskschat_html.addTaskInput | 1 | 0 | 1 |
| static_taskschat_html.button_10 | 1 | 1 | 2 |
| static_taskschat_html.button_17 | 1 | 1 | 2 |
| static_taskschat_html.button_7 | 1 | 1 | 2 |
| static_taskschat_html.h3_82 | 1 | 1 | 2 |
| static_terms_html.https:_finallydoneapp.com_privacy | 1 | 1 | 2 |
| tasksChat._urlsafe_b64decode | 1 | 0 | 1 |

## top_connected_nodes
Evidence: total callgraph degree count only.
| Node | Total degree | In-degree | Out-degree |
| --- | --- | --- | --- |
| tasksChat__get_google_token_for_request | 9 | 7 | 2 |
| tasksChat.now_ts | 6 | 6 | 0 |
| tasksChat__now_ts | 6 | 6 | 0 |
| static_taskschat_html.file | 5 | 0 | 5 |
| js.loadTasks | 4 | 0 | 4 |
| tasksChat.oauth_callback | 4 | 1 | 3 |
| tasksChat.get_valid_google_token | 3 | 1 | 2 |
| tasksChat.oauth_start | 3 | 1 | 2 |
| tasksChat__get_valid_google_token | 3 | 1 | 2 |
| tasksChat__oauth_callback | 3 | 0 | 3 |
| api.create-task | 2 | 1 | 1 |
| api.list-task-lists | 2 | 1 | 1 |
| api.list-tasks | 2 | 1 | 1 |
| js.addTask | 2 | 1 | 1 |
| js.toggleTaskStatus | 2 | 0 | 2 |
| privacy_html.mailto:finallydoneapp_gmail.com | 2 | 1 | 1 |
| static_privacy_html.mailto:finallydoneapp_gmail.com | 2 | 1 | 1 |
| static_taskschat_html.button_10 | 2 | 1 | 1 |
| static_taskschat_html.button_17 | 2 | 1 | 1 |
| static_taskschat_html.button_7 | 2 | 1 | 1 |
| static_taskschat_html.h3_82 | 2 | 1 | 1 |
| static_terms_html.https:_finallydoneapp.com_privacy | 2 | 1 | 1 |
| tasksChat | 2 | 0 | 2 |
| tasksChat.create_user_with_google_tokens | 2 | 1 | 1 |
| tasksChat.debug_pending_states | 2 | 1 | 1 |
| tasksChat.oauth_token | 2 | 1 | 1 |
| tasksChat.parse_signed_oauth_state | 2 | 1 | 1 |
| tasksChat__create_user_with_google_tokens | 2 | 1 | 1 |
| tasksChat__get_current_user | 2 | 2 | 0 |
| tasksChat__oauth_start | 2 | 0 | 2 |

## complex_functions
Evidence: callgraph out-degree count only. Higher out-degree means the node calls more extracted targets.
| Node | Out-degree | In-degree | Total degree |
| --- | --- | --- | --- |
| static_taskschat_html.file | 5 | 0 | 5 |
| js.loadTasks | 4 | 0 | 4 |
| tasksChat.oauth_callback | 3 | 1 | 4 |
| tasksChat__oauth_callback | 3 | 0 | 3 |
| js.toggleTaskStatus | 2 | 0 | 2 |
| tasksChat | 2 | 0 | 2 |
| tasksChat.get_valid_google_token | 2 | 1 | 3 |
| tasksChat.oauth_start | 2 | 1 | 3 |
| tasksChat__get_google_token_for_request | 2 | 7 | 9 |
| tasksChat__get_valid_google_token | 2 | 1 | 3 |
| tasksChat__oauth_start | 2 | 0 | 2 |
| api.complete-task_task_id | 1 | 0 | 1 |
| api.create-task | 1 | 1 | 2 |
| api.debug_pending-states | 1 | 0 | 1 |
| api.list-task-lists | 1 | 1 | 2 |
| api.list-tasks | 1 | 1 | 2 |
| api.oauth_google_callback | 1 | 0 | 1 |
| api.oauth_start | 1 | 0 | 1 |
| api.oauth_token | 1 | 0 | 1 |
| api.privacy | 1 | 0 | 1 |
| api.privacy.html | 1 | 0 | 1 |
| api.taskschat.html | 1 | 0 | 1 |
| api.terms | 1 | 0 | 1 |
| api.terms.html | 1 | 0 | 1 |
| api.uncomplete-task_task_id | 1 | 0 | 1 |
| api.update-task_task_id | 1 | 0 | 1 |
| js.addTask | 1 | 1 | 2 |
| js.deleteTask | 1 | 0 | 1 |
| js.loadLists | 1 | 0 | 1 |
| js.starTask | 1 | 0 | 1 |

## file_dependencies
Evidence: direct file graph edges from the file graph artifact.
| Source file | Target file | Evidence reason |
| --- | --- | --- |
| static/taskschat.html | tasksChat.py | fetch/API |

## core_files
Evidence: file graph degree count only.
| File | Total degree | In-degree | Out-degree |
| --- | --- | --- | --- |
| static/taskschat.html | 1 | 0 | 1 |
| tasksChat.py | 1 | 1 | 0 |

## database_writes
Evidence: actual source matches to `table/from/collection` write operations, plus caller count for the enclosing Python callgraph function when available. No name-only matching is used.
_No rows found from the available direct evidence._

## external_calls
Evidence: direct Python/JavaScript/TypeScript import detection, excluding stdlib and local top-level modules.
| Package/module | Import count | Examples |
| --- | --- | --- |
| fastapi | 3 | tasksChat.py:11, tasksChat.py:12, tasksChat.py:13 |
| requests | 1 | tasksChat.py:10 |

## ui_interactions
Evidence: direct HTML/UI element extraction from the HTML UI graph artifact.
| File | Line | Tag | Attributes |
| --- | --- | --- | --- |
| privacy.html | 96 | a | {"text": "finally-done-group@googlegroups.com", "href": "mailto:finallydoneapp@gmail.com"} |
| static/privacy.html | 96 | a | {"text": "finally-done-group@googlegroups.com", "href": "mailto:finallydoneapp@gmail.com"} |
| static/taskschat.html | 7 | button | {"text": "Sign in with Google Tasks"} |
| static/taskschat.html | 10 | button | {"text": "Chat with my Tasks"} |
| static/taskschat.html | 16 | input | {"id": "addTaskInput", "text": "New task title"} |
| static/taskschat.html | 17 | button | {"text": "Add Task"} |
| static/terms.html | 51 | a | {"text": "Privacy Policy", "href": "https://finallydoneapp.com/privacy"} |
| terms.html | 51 | a | {"text": "Privacy Policy", "href": "https://finallydoneapp.com/privacy"} |

## known_todos
Evidence: literal TODO/FIXME-style comment extraction from repo comments.
_No rows found from the available direct evidence._

## recently_changed
Evidence: local `git log` when a `.git` directory is available; otherwise concrete GitHub commit payload from analysis if present.
_No rows found from the available direct evidence._

## high_churn_files
Evidence: file occurrence/change count from local git history when available; otherwise concrete GitHub changed-file payload from analysis if present.
_No rows found from the available direct evidence._

## stable_files
Evidence: tracked files with zero touches in the latest 100 local git commits. Empty when no local `.git` evidence is available.
_No rows found from the available direct evidence._
