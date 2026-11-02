use dns_lookup::{AddrInfoHints, getaddrinfo};
use nix::libc::{AF_INET, SOCK_STREAM};
use reqwest::dns::{Addrs, Name, Resolve, Resolving};
use std::net::SocketAddr;

pub struct Ipv4Resolver;

impl Resolve for Ipv4Resolver {
    fn resolve(&self, name: Name) -> Resolving {
        Box::pin(async move {
            let hints = AddrInfoHints {
                address: AF_INET,
                socktype: SOCK_STREAM,
                ..Default::default()
            };
            let addresses = tokio::task::spawn_blocking(move || {
                getaddrinfo(Some(name.as_str()), None, Some(hints))?
                    .map(|entry| entry.map(|info| info.sockaddr))
                    .collect::<std::io::Result<Vec<SocketAddr>>>()
            })
            .await??;
            Ok(Box::new(addresses.into_iter()) as Addrs)
        })
    }
}
