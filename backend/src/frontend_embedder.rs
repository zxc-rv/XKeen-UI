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

    if let Some(file) = StaticFiles::get(&format!("{}.gz", path)) {
        return build_res(path, file.data, true);
    }

    if let Some(file) = StaticFiles::get(path) {
        return build_res(path, file.data, false);
    }

    Response::builder()
        .status(404)
        .body(Body::empty())
        .unwrap()
}

fn build_res(path: &str, data: impl Into<Body>, is_gzipped: bool) -> Response {
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

    builder.body(data.into()).unwrap()
}