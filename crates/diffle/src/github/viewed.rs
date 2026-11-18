//! The current GitHub viewer's marks for a pull request.
use std::collections::{HashMap, HashSet};
use std::time::Duration;

use serde::Deserialize;
use serde_json::{Value, json};

use super::{client::GithubClient, pulls::repo_of_pr_url};
use crate::error::GithubError;
use crate::protocol::{PullRef, ViewedEntry};

const TIMEOUT: Option<Duration> = Some(Duration::from_secs(5));
const FILES: &str = "query($owner:String!,$repo:String!,$number:Int!,$after:String){repository(owner:$owner,name:$repo){pullRequest(number:$number){id headRefOid baseRefOid files(first:100,after:$after){nodes{path viewerViewedState} pageInfo{hasNextPage endCursor}}}}}";
const HEAD: &str = "query($id:ID!){node(id:$id){...on PullRequest{headRefOid baseRefOid}}}";

#[derive(Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct Refs {
    head_ref_oid: String,
    base_ref_oid: String,
}

#[derive(Deserialize)]
struct PullPage {
    id: String,
    #[serde(flatten)]
    refs: Refs,
    files: FilePage,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FilePage {
    nodes: Vec<Option<File>>,
    page_info: PageInfo,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PageInfo {
    has_next_page: bool,
    end_cursor: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct File {
    path: String,
    viewer_viewed_state: FileState,
}

#[derive(Clone, Copy, Deserialize, PartialEq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum FileState {
    Viewed,
    Unviewed,
    Dismissed,
}

pub struct ViewedFiles {
    id: String,
    refs: Refs,
    pub states: HashMap<String, FileState>,
}

fn unreadable() -> GithubError {
    GithubError::new("Cannot read viewed files from GitHub", 502)
}

pub fn changed() -> GithubError {
    GithubError::conflict("The pull request changed on GitHub. Reload it before marking files viewed.")
}

impl ViewedFiles {
    pub fn head(&self) -> &str {
        &self.refs.head_ref_oid
    }

    pub fn base(&self) -> &str {
        &self.refs.base_ref_oid
    }

    async fn check_refs(&self, client: &dyn GithubClient) -> Result<(), GithubError> {
        let data = client.graphql(HEAD, json!({ "id": self.id }), TIMEOUT).await?;
        let refs: Refs = serde_json::from_value(data["node"].clone()).map_err(|_| unreadable())?;
        if refs != self.refs {
            return Err(changed());
        }
        Ok(())
    }

    pub async fn write(
        &mut self,
        client: &dyn GithubClient,
        entries: &[ViewedEntry],
        current: impl Fn() -> bool,
    ) -> Result<(), GithubError> {
        for batch in entries.chunks(25) {
            // GitHub accepts a PR id and path only. Check both refs immediately before writing.
            self.check_refs(client).await?;
            if !current() {
                return Err(changed());
            }
            let (query, variables) = mutation(&self.id, batch);
            let result = client.graphql(&query, variables, TIMEOUT).await?;
            for (index, entry) in batch.iter().enumerate() {
                let pr = &result[format!("file{index}")]["pullRequest"];
                let refs: Refs = serde_json::from_value(pr.clone()).map_err(|_| unreadable())?;
                if refs != self.refs {
                    return Err(changed());
                }
                let state = if entry.viewed { FileState::Viewed } else { FileState::Unviewed };
                self.states.insert(entry.path.clone(), state);
            }
        }
        Ok(())
    }
}

pub async fn read(client: &dyn GithubClient, pr: &PullRef) -> Result<ViewedFiles, GithubError> {
    let (owner, repo) = repo_of_pr_url(&pr.url)?;
    let mut seen = HashSet::new();
    let mut after = None;
    let mut viewed: Option<ViewedFiles> = None;
    loop {
        let variables = json!({ "owner": owner, "repo": repo, "number": pr.number, "after": after });
        let data = client.graphql(FILES, variables, TIMEOUT).await?;
        let pull: PullPage =
            serde_json::from_value(data["repository"]["pullRequest"].clone()).map_err(|_| unreadable())?;
        let files = match &mut viewed {
            Some(files) if files.id != pull.id || files.refs != pull.refs => return Err(changed()),
            Some(files) => files,
            slot => slot.insert(ViewedFiles { id: pull.id, refs: pull.refs, states: HashMap::new() }),
        };
        files.states.extend(pull.files.nodes.into_iter().flatten().map(|file| (file.path, file.viewer_viewed_state)));
        let page = pull.files.page_info;
        if !page.has_next_page {
            return Ok(viewed.expect("at least one page"));
        }
        let next = page.end_cursor.filter(|cursor| seen.insert(cursor.clone())).ok_or_else(unreadable)?;
        after = Some(next);
    }
}

fn mutation(id: &str, entries: &[ViewedEntry]) -> (String, Value) {
    let mut declarations = Vec::new();
    let mut fields = Vec::new();
    let mut variables = serde_json::Map::new();
    for (index, entry) in entries.iter().enumerate() {
        let (field, input) = if entry.viewed {
            ("markFileAsViewed", "MarkFileAsViewedInput")
        } else {
            ("unmarkFileAsViewed", "UnmarkFileAsViewedInput")
        };
        declarations.push(format!("$input{index}:{input}!"));
        fields.push(format!("file{index}:{field}(input:$input{index}){{pullRequest{{headRefOid baseRefOid}}}}"));
        variables.insert(format!("input{index}"), json!({ "pullRequestId": id, "path": entry.path }));
    }
    (format!("mutation({}){{{}}}", declarations.join(","), fields.join(" ")), Value::Object(variables))
}
