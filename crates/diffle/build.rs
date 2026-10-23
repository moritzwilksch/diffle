// Generates the wire types from the JSON Schema that `protocol.ts` exports.
use std::{env, fs, path::Path};

fn main() {
    // A release build embeds the client; a rebuild of it renames its hashed assets.
    println!("cargo:rerun-if-changed=client");

    let schema_path = "protocol.generated.json";
    println!("cargo:rerun-if-changed={schema_path}");
    let text = fs::read_to_string(schema_path).expect("read protocol schema");
    let schema: schemars::schema::RootSchema = serde_json::from_str(&text).expect("parse protocol schema");
    let mut space = typify::TypeSpace::new(typify::TypeSpaceSettings::default().with_struct_builder(false));
    space.add_root_schema(schema).expect("convert protocol schema");
    let file = syn::parse2::<syn::File>(space.to_stream()).expect("parse generated types");
    let out = Path::new(&env::var("OUT_DIR").unwrap()).join("protocol.rs");
    fs::write(out, prettyplease::unparse(&file)).expect("write generated types");
}
