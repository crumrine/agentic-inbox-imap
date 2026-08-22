// Copyright (c) 2026 Brian Crumrine
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

// Package config loads and validates agentic-imapd configuration from
// environment variables.
package config

import (
	"fmt"
	"net"
	"net/url"
	"os"
	"strconv"
	"strings"
)

// Environment variable names. Exported so main.go and tests can reference
// them without repeating string literals.
const (
	EnvInboxURL           = "AGENTIC_INBOX_URL"
	EnvAccessClientID     = "AGENTIC_ACCESS_CLIENT_ID"
	EnvAccessClientSecret = "AGENTIC_ACCESS_CLIENT_SECRET"
	EnvAccessCookie       = "AGENTIC_ACCESS_COOKIE"
	EnvIMAPAddr           = "AGENTIC_IMAP_ADDR"
	EnvTLSCert            = "AGENTIC_TLS_CERT"
	EnvTLSKey             = "AGENTIC_TLS_KEY"
	EnvLogLevel           = "AGENTIC_LOG_LEVEL"
	EnvAllowPublicBind    = "AGENTIC_ALLOW_PUBLIC_BIND"
)

// DefaultIMAPPort is used when AGENTIC_IMAP_ADDR is unset and a Tailscale
// interface address can be auto-detected.
const DefaultIMAPPort = "993"

// DefaultLogLevel is used when AGENTIC_LOG_LEVEL is unset.
const DefaultLogLevel = "info"

// Config holds the fully validated runtime configuration for agentic-imapd.
//
// Config never carries a String()/GoString() implementation that dumps
// AccessClientSecret; callers must not %+v this struct into logs.
type Config struct {
	// InboxURL is the base URL of the Worker backend.
	InboxURL *url.URL

	// AccessClientID and AccessClientSecret are the Cloudflare Access
	// service token sent on every request to the Worker.
	AccessClientID     string
	AccessClientSecret string

	// AccessCookie is a testing-only alternative to the service token.
	// See backend.WithAccessCookie.
	AccessCookie string

	// IMAPAddr is the address agentic-imapd listens on for IMAP
	// connections, e.g. "100.64.1.2:993".
	IMAPAddr string

	// TLSCertFile and TLSKeyFile are paths to `tailscale cert` output.
	TLSCertFile string
	TLSKeyFile  string

	// LogLevel is a free-form level name (debug, info, warn, error).
	LogLevel string

	// AllowPublicBind disables the public-bind safety interlock. Set via
	// AGENTIC_ALLOW_PUBLIC_BIND=true. Should never be set in production.
	AllowPublicBind bool
}

// Load reads configuration from the environment, validates it, and applies
// the public-bind safety interlock. On failure it returns an error naming
// the missing or invalid variable; it never includes secret values in error
// text.
func Load() (*Config, error) {
	return load(os.LookupEnv)
}

// lookupFunc matches os.LookupEnv's signature so tests can inject a fake
// environment instead of mutating process-global state.
type lookupFunc func(key string) (string, bool)

func load(lookup lookupFunc) (*Config, error) {
	rawURL, ok := lookup(EnvInboxURL)
	if !ok || strings.TrimSpace(rawURL) == "" {
		return nil, fmt.Errorf("config: missing required environment variable %s", EnvInboxURL)
	}
	inboxURL, err := url.Parse(rawURL)
	if err != nil {
		return nil, fmt.Errorf("config: %s is not a valid URL: %w", EnvInboxURL, err)
	}
	if inboxURL.Scheme != "https" && inboxURL.Scheme != "http" {
		return nil, fmt.Errorf("config: %s must be an http(s) URL", EnvInboxURL)
	}

	// Cloudflare Access needs either a service token (production) or a
	// CF_Authorization cookie (local testing, see AccessCookie). Requiring
	// one of the two rather than the token specifically is what lets the
	// gateway run before a service token has been provisioned.
	rawCookie, _ := lookup(EnvAccessCookie)
	accessCookie := strings.TrimSpace(rawCookie)

	rawClientID, _ := lookup(EnvAccessClientID)
	rawClientSecret, _ := lookup(EnvAccessClientSecret)
	clientID := strings.TrimSpace(rawClientID)
	clientSecret := strings.TrimSpace(rawClientSecret)

	hasToken := clientID != "" && clientSecret != ""
	if accessCookie == "" && !hasToken {
		return nil, fmt.Errorf(
			"config: no Cloudflare Access credential. Set %s and %s, or %s for local testing",
			EnvAccessClientID, EnvAccessClientSecret, EnvAccessCookie)
	}
	// A half-configured service token is a mistake worth naming rather than
	// silently falling back to no credential at all.
	if accessCookie == "" && (clientID != "") != (clientSecret != "") {
		return nil, fmt.Errorf("config: %s and %s must both be set", EnvAccessClientID, EnvAccessClientSecret)
	}

	certFile, ok := lookup(EnvTLSCert)
	if !ok || strings.TrimSpace(certFile) == "" {
		return nil, fmt.Errorf("config: missing required environment variable %s", EnvTLSCert)
	}

	keyFile, ok := lookup(EnvTLSKey)
	if !ok || strings.TrimSpace(keyFile) == "" {
		return nil, fmt.Errorf("config: missing required environment variable %s", EnvTLSKey)
	}

	allowPublicBind := false
	if raw, ok := lookup(EnvAllowPublicBind); ok && strings.TrimSpace(raw) != "" {
		parsed, err := strconv.ParseBool(raw)
		if err != nil {
			return nil, fmt.Errorf("config: %s must be a boolean (true/false), got %q", EnvAllowPublicBind, raw)
		}
		allowPublicBind = parsed
	}

	addr, ok := lookup(EnvIMAPAddr)
	if !ok || strings.TrimSpace(addr) == "" {
		detected, err := DefaultTailscaleAddr()
		if err != nil {
			return nil, fmt.Errorf("config: %s not set and no Tailscale interface address could be found (%w); set %s explicitly", EnvIMAPAddr, err, EnvIMAPAddr)
		}
		addr = detected
	}

	if err := CheckBindAddr(addr, allowPublicBind); err != nil {
		return nil, fmt.Errorf("config: refusing to start: %w", err)
	}

	logLevel := DefaultLogLevel
	if raw, ok := lookup(EnvLogLevel); ok && strings.TrimSpace(raw) != "" {
		logLevel = raw
	}

	return &Config{
		InboxURL:           inboxURL,
		AccessClientID:     clientID,
		AccessClientSecret: clientSecret,
		AccessCookie:       accessCookie,
		IMAPAddr:           addr,
		TLSCertFile:        certFile,
		TLSKeyFile:         keyFile,
		LogLevel:           logLevel,
		AllowPublicBind:    allowPublicBind,
	}, nil
}

// tailscaleCGNAT is the CGNAT range Tailscale allocates addresses from.
var tailscaleCGNAT = mustParseCIDR("100.64.0.0/10")

func mustParseCIDR(s string) *net.IPNet {
	_, n, err := net.ParseCIDR(s)
	if err != nil {
		panic(err)
	}
	return n
}

// IsAllowedBindHost reports whether ip is safe to listen on: loopback or
// within the Tailscale CGNAT range (100.64.0.0/10).
func IsAllowedBindHost(ip net.IP) bool {
	if ip == nil {
		return false
	}
	if ip.IsLoopback() {
		return true
	}
	return tailscaleCGNAT.Contains(ip)
}

// resolveFunc matches the subset of net.Resolver used to resolve hostnames
// to IPs, so tests can avoid touching the real network.
type resolveFunc func(host string) ([]net.IP, error)

func defaultResolve(host string) ([]net.IP, error) {
	return net.LookupIP(host)
}

// CheckBindAddr is the public-bind safety interlock. It refuses to allow a
// listen address that is not loopback or Tailscale CGNAT range, unless
// allowPublic is true (AGENTIC_ALLOW_PUBLIC_BIND=true).
//
// addr must be a "host:port" pair. An empty host (e.g. ":993", which binds
// all interfaces) is always treated as public.
func CheckBindAddr(addr string, allowPublic bool) error {
	return checkBindAddr(addr, allowPublic, defaultResolve)
}

func checkBindAddr(addr string, allowPublic bool, resolve resolveFunc) error {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return fmt.Errorf("invalid listen address %q: %w", addr, err)
	}

	if host == "" {
		if allowPublic {
			return nil
		}
		return fmt.Errorf("listen address %q binds all interfaces (public); set %s=true to override", addr, EnvAllowPublicBind)
	}

	if ip := net.ParseIP(host); ip != nil {
		if IsAllowedBindHost(ip) || allowPublic {
			return nil
		}
		return fmt.Errorf("listen address %q is not loopback or a Tailscale address (100.64.0.0/10); set %s=true to override", addr, EnvAllowPublicBind)
	}

	// Hostname: resolve and check every returned address.
	ips, err := resolve(host)
	if err != nil {
		return fmt.Errorf("could not resolve listen host %q: %w", host, err)
	}
	if len(ips) == 0 {
		return fmt.Errorf("listen host %q resolved to no addresses", host)
	}
	for _, ip := range ips {
		if !IsAllowedBindHost(ip) && !allowPublic {
			return fmt.Errorf("listen host %q resolves to %s, which is not loopback or a Tailscale address (100.64.0.0/10); set %s=true to override", host, ip, EnvAllowPublicBind)
		}
	}
	return nil
}

// DefaultTailscaleAddr scans local network interfaces for an address in the
// Tailscale CGNAT range and returns "ip:993". It returns an error if none is
// found.
func DefaultTailscaleAddr() (string, error) {
	addrs, err := net.InterfaceAddrs()
	if err != nil {
		return "", fmt.Errorf("listing network interfaces: %w", err)
	}
	for _, a := range addrs {
		ipNet, ok := a.(*net.IPNet)
		if !ok {
			continue
		}
		if tailscaleCGNAT.Contains(ipNet.IP) {
			return net.JoinHostPort(ipNet.IP.String(), DefaultIMAPPort), nil
		}
	}
	return "", fmt.Errorf("no interface address found in 100.64.0.0/10 (is Tailscale up?)")
}
