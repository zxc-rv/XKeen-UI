use crate::types::UpdateSession;
use dns_lookup::{AddrInfoHints, getaddrinfo};
use futures_util::future::select_ok;
use nix::libc::{AF_INET, AF_INET6, SOCK_STREAM};
use reqwest::dns::{Addrs, Name, Resolve, Resolving};
use rustls::pki_types::ServerName;
use rustls::{ClientConfig, RootCertStore};
use std::io::{Error, ErrorKind};
use std::net::SocketAddr;
use std::sync::{Arc, LazyLock};
use std::time::Duration;
use tokio::net::TcpStream;
use tokio::time::timeout;
use tokio_rustls::TlsConnector;

const IPV4_ONLY_DOMAINS: [&str; 2] = ["github.com", "githubusercontent.com"];
const HTTPS_PORT: u16 = 443;
const PROBE_TIMEOUT: Duration = Duration::from_secs(5);

static TLS_CONNECTOR: LazyLock<TlsConnector> = LazyLock::new(|| {
    let roots = RootCertStore::from_iter(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    let config = ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_root_certificates(roots)
        .with_no_client_auth();
    TlsConnector::from(Arc::new(config))
});

#[derive(Debug)]
struct ResolveError {
    host: String,
    reason: Error,
}

impl std::fmt::Display for ResolveError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.host, self.reason)
    }
}

impl std::error::Error for ResolveError {}

pub struct HostResolver {
    pub session: Option<UpdateSession>,
}

async fn lookup(host: String, family: i32) -> std::io::Result<Vec<SocketAddr>> {
    tokio::task::spawn_blocking(move || {
        let hints = AddrInfoHints {
            address: family,
            socktype: SOCK_STREAM,
            ..Default::default()
        };
        getaddrinfo(Some(&host), None, Some(hints))?
            .map(|entry| entry.map(|info| info.sockaddr))
            .collect()
    })
    .await?
}

async fn probe(host: String, address: SocketAddr) -> std::io::Result<SocketAddr> {
    let server_name = ServerName::try_from(host).map_err(|error| Error::new(ErrorKind::InvalidInput, error))?;
    timeout(PROBE_TIMEOUT, async {
        let stream = TcpStream::connect(SocketAddr::new(address.ip(), HTTPS_PORT)).await?;
        TLS_CONNECTOR.connect(server_name, stream).await?;
        Ok(address)
    })
    .await?
}

impl Resolve for HostResolver {
    fn resolve(&self, name: Name) -> Resolving {
        let session = self.session.clone();
        Box::pin(async move {
            let host = name.as_str().to_owned();
            let ipv4_only = IPV4_ONLY_DOMAINS
                .iter()
                .any(|domain| host == *domain || host.ends_with(&format!(".{domain}")));
            let (ipv4, ipv6) = tokio::join!(lookup(host.clone(), AF_INET), async {
                if ipv4_only {
                    Err(Error::from(ErrorKind::Unsupported))
                } else {
                    lookup(host.clone(), AF_INET6).await
                }
            });
            let addresses: Vec<SocketAddr> = match (ipv4, ipv6) {
                (Err(reason), Err(_)) => return Err(ResolveError { host, reason }.into()),
                (ipv4, ipv6) => ipv4.into_iter().chain(ipv6).flatten().collect(),
            };
            if let Some(session) = &session {
                let readable: Vec<String> = addresses.iter().map(|address| address.ip().to_string()).collect();
                session.log("info", format!("Хост {host} разрешен в [{}]", readable.join(", ")));
                session.log("info", format!("Установка соединения с {host}..."));
            }
            if addresses.is_empty() {
                return Ok(Box::new(addresses.into_iter()) as Addrs);
            }
            let probes = addresses.iter().map(|address| Box::pin(probe(host.clone(), *address)));
            let selected = match select_ok(probes).await {
                Ok((address, _)) => vec![address],
                Err(_) => addresses,
            };
            Ok(Box::new(selected.into_iter()) as Addrs)
        })
    }
}
