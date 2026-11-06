//! `GET /api/lsp/graph` over a fake language server that outlines and references Python by text.
#![cfg(unix)]
mod common;

use std::collections::HashMap;

use serde_json::Value;

use common::TestRepo;
use common::lsp::{eventually, fake_env, fake_servers};
use common::server::TestServer;
use diffle::protocol::{EnterRequest, LanguageId, LspState};

/// cli → runner → agent → client, plus `report.py` using the agent untouched. The worktree edits
/// `Client.get` and `Agent.run`, and adds `make_agent` for `run_all` to call.
fn agent_repo() -> TestRepo {
    let t = TestRepo::new();
    std::fs::write(t.path.join(".git/info/exclude"), ".fake-env*\n").unwrap();
    t.write("client.py", "class Client:\n    def get(self, url):\n        return url\n");
    t.write(
        "agent.py",
        "from client import Client\n\nclass Agent:\n    def __init__(self):\n        self.client = Client()\n\n    def run(self, task):\n        return task\n",
    );
    t.write(
        "runner.py",
        "from agent import Agent\n\ndef run_all(tasks):\n    return [Agent().run(t) for t in tasks]\n",
    );
    t.write("cli.py", "from runner import run_all\n\ndef main():\n    print(run_all(['a']))\n");
    t.write("report.py", "from agent import Agent\n\ndef summarize():\n    return Agent().run('sum')\n");
    t.commit("base");
    t.write("client.py", "class Client:\n    def get(self, url):\n        return url.strip()\n");
    t.write(
        "agent.py",
        "from client import Client\n\nclass Agent:\n    def __init__(self):\n        self.client = Client()\n\n    def run(self, task):\n        return self.client.get(task)\n",
    );
    t.write(
        "runner.py",
        "from agent import Agent\n\ndef make_agent():\n    return Agent()\n\ndef run_all(tasks):\n    agent = make_agent()\n    return [agent.run(t) for t in tasks]\n",
    );
    t
}

/// One line per node, then per edge, naming nodes by `path name`, for a reviewer to read.
fn render(graph: &Value) -> String {
    let nodes = graph["nodes"].as_array().unwrap();
    let names: HashMap<&str, String> = nodes
        .iter()
        .map(|n| {
            let name = if n["kind"] == 1 {
                n["path"].as_str().unwrap().to_owned()
            } else {
                format!("{} {}", n["path"].as_str().unwrap(), n["name"].as_str().unwrap())
            };
            (n["id"].as_str().unwrap(), name)
        })
        .collect();
    let mut out = String::new();
    for n in nodes {
        let more = n.get("moreConsumers").map_or(String::new(), |m| format!(" +{m}"));
        out += &format!(
            "{:<9} kind {:<2} {}:{}-{}{more}\n",
            n["status"].as_str().unwrap(),
            n["kind"],
            names[n["id"].as_str().unwrap()],
            n["line"],
            n["endLine"]
        );
    }
    for e in graph["edges"].as_array().unwrap() {
        out += &format!(
            "{} -> {} at {}\n",
            names[e["from"].as_str().unwrap()],
            names[e["to"].as_str().unwrap()],
            e["lines"]
        );
    }
    for n in graph["cut"].as_array().unwrap() {
        out += &format!("cut {} {}\n", n["path"].as_str().unwrap(), n["name"].as_str().unwrap());
    }
    out
}

#[tokio::test]
async fn graphs_changed_symbols_with_the_code_using_them() {
    if fake_servers().is_none() {
        return;
    }
    let t = agent_repo();
    fake_env(&t.path, Some("fake"), &[("FAKE_LSP_GRAPH", "1")]);
    let overrides = HashMap::from([(LanguageId::Python, "fake".to_owned())]);
    let s = TestServer::with_lsp(t, EnterRequest::Working, Some(overrides)).await;
    eventually("a ready server", || {
        s.lsp.as_ref().unwrap().status().servers.iter().any(|x| x.state == LspState::Ready)
    })
    .await;
    let res = s.get("/api/lsp/graph").await;
    assert_eq!(res.status, 200, "{}", res.body);
    insta::assert_snapshot!(render(&res.json()));
    s.close().await;
}

#[tokio::test]
async fn a_scope_graphs_only_the_changed_files_under_it() {
    if fake_servers().is_none() {
        return;
    }
    let t = agent_repo();
    t.write("jobs/nightly.py", "def nightly():\n    return 1\n");
    fake_env(&t.path, Some("fake"), &[("FAKE_LSP_GRAPH", "1")]);
    let overrides = HashMap::from([(LanguageId::Python, "fake".to_owned())]);
    let s = TestServer::with_lsp(t, EnterRequest::Working, Some(overrides)).await;
    eventually("a ready server", || {
        s.lsp.as_ref().unwrap().status().servers.iter().any(|x| x.state == LspState::Ready)
    })
    .await;
    let res = s.get("/api/lsp/graph?scope=jobs").await;
    assert_eq!(res.status, 200, "{}", res.body);
    insta::assert_snapshot!(render(&res.json()), @"modified  kind 12 jobs/nightly.py nightly:1-3");
    s.close().await;
}

#[tokio::test]
async fn refuses_a_graph_when_the_new_side_is_not_the_checkout() {
    if fake_servers().is_none() {
        return;
    }
    let t = agent_repo();
    t.commit("change");
    fake_env(&t.path, Some("fake"), &[("FAKE_LSP_GRAPH", "1")]);
    let overrides = HashMap::from([(LanguageId::Python, "fake".to_owned())]);
    let s = TestServer::with_lsp(t, common::revspec(&["HEAD~1^!"]), Some(overrides)).await;
    let res = s.get("/api/lsp/graph").await;
    assert_eq!(res.status, 409, "{}", res.body);
    s.close().await;
}
