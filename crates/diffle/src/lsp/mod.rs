//! Language servers: started per language the diff holds, kept in step with the snapshot, and asked
//! the queries the review needs.
pub mod bridge;
pub mod configuration;
pub mod documents;
pub mod hover;
pub mod locator;
pub mod merge;
pub mod output;
pub mod pool;
pub mod pool_server;
pub mod process;
pub mod projects;
pub mod registry;
pub mod rpc;
pub mod shapes;
pub mod which;
