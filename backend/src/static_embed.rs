use axum::{
    body::Body,
    http::{Uri, header},
    response::Response,
};
use rust_embed::Embed;

#[derive(Embed)]
#[folder = "../frontend/dist"]
struct StaticFiles;

pub async fn serve(uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    let path = if path.is_empty() { "index.html" } else { path };

    let (lookup, is_gzipped) = match StaticFiles::get(&format!("{}.gz", path)) {
        Some(file) => (file, true),
        None => match StaticFiles::get(path) {
            Some(file) => (file, false),
            None => return spa_fallback(),
        },
    };

    let mime = mime_guess::from_path(path).first_or_octet_stream();
    let cache = if path == "index.html" {
        "no-store"
    } else {
        "public, max-age=31536000, immutable"
    };

    let mut builder = Response::builder()
        .header(header::CONTENT_TYPE, mime.as_ref())
        .header(header::CACHE_CONTROL, cache);

    if is_gzipped {
        builder = builder.header(header::CONTENT_ENCODING, "gzip");
    }

    builder.body(Body::from(lookup.data)).unwrap()
}

fn spa_fallback() -> Response {
    match StaticFiles::get("index.html") {
        Some(file) => Response::builder()
            .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
            .header(header::CACHE_CONTROL, "no-store")
            .body(Body::from(file.data))
            .unwrap(),
        None => Response::builder()
            .status(404)
            .body(Body::empty())
            .unwrap(),
    }
}