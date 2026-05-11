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

    StaticFiles::get(&format!("{path}.gz"))
        .map(|f| build_res(path, f.data, true))
        .or_else(|| StaticFiles::get(path).map(|f| build_res(path, f.data, false)))
        .unwrap_or_else(|| Response::builder().status(404).body(Body::empty()).unwrap())
}

fn build_res(path: &str, data: impl Into<Body>, is_gz: bool) -> Response {
    let mut res = Response::builder()
        .header(
            header::CONTENT_TYPE,
            mime_guess::from_path(path).first_or_octet_stream().as_ref(),
        )
        .header(
            header::CACHE_CONTROL,
            if path == "index.html" {
                "no-store"
            } else {
                "public, max-age=31536000, immutable"
            },
        );

    if is_gz {
        res = res.header(header::CONTENT_ENCODING, "gzip");
    }

    res.body(data.into()).unwrap()
}
