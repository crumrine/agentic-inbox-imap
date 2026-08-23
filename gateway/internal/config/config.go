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
	EnvSMTPAddr           = "AGENTIC_SMTP_ADDR"
	EnvTLSCert            = "AGENTIC_TLS_CERT"
	EnvTLSKey             = "AGENTIC_TLS_KEY"
	EnvLogLevel           = "AGENTIC_LOG_LEVEL"
	EnvAllowPublicBind    = "AGENTIC_ALLOW_PUBLIC_BIND"
)

// DefaultIMAPPort is used when AGENTIC_IMAP_ADDR is unset and a Tailscale
// interface address can be auto-detected.
const DefaultIMAPPort = "993"

// DefaultSMTPPort is used when AGENTIC_SMTP_ADDR is unset and a Tailscale
// interface address can be auto-detected. 465 is implicit TLS submission;
// there is deliberately no 587 STARTTLS path.
const DefaultSMTPPort = "465"

// smtpDisabledValues turn the submission listener off explicitly. Leaving
// AGENTIC_SMTP_ADDR unset enables it on the detected Tailscale address, so
// there has to be a way to say no.
var smtpDisabledValues = map[string]bool{
	"off":      true,
	"none":     true,
	"disabled": true,
	"false":    true,
}

// DefaultLogLevel is used when AGENTIC_LOG_LEVEL is unset.
const DefaultLogLevel = "info"

// Config holds the fully validated runtime configuration for agentic-imapd.
//
// String and GoString are implemented to redact AccessClientSecret and
// AccessCookie, so formatting a Config into a log line is safe by default
// rather than by convention. Do not remove them.
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

	// SMTPAddr is the address the submission listener binds, e.g.
	// "100.64.1.2:465". Empty means submission is disabled, either because
	// it was turned off explicitly or because no Tailscale address could
	// be detected for it. IMAP runs either way.
	SMTPAddr string

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

	smtpAddr, err := loadSMTPAddr(lookup, allowPublicBind)
	if err != nil {
		return nil, err
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
		SMTPAddr:           smtpAddr,
		TLSCertFile:        certFile,
		TLSKeyFile:         keyFile,
		LogLevel:           logLevel,
		AllowPublicBind:    allowPublicBind,
	}, nil
}

// loadSMTPAddr resolves the submission listen address.
//
// Unset means "the detected Tailscale address on 465", matching IMAP. If
// no such address can be found the result is empty rather than an error:
// submission is an addition, and it must never be the reason a working
// IMAP deployment stops starting.
func loadSMTPAddr(lookup lookupFunc, allowPublic bool) (string, error) {
	raw, ok := lookup(EnvSMTPAddr)
	trimmed := strings.TrimSpace(raw)

	if ok && smtpDisabledValues[strings.ToLower(trimmed)] {
		return "", nil
	}

	if !ok || trimmed == "" {
		detected, err := DefaultTailscaleAddrPort(DefaultSMTPPort)
		if err != nil {
			// Not fatal, by design. See the doc comment.
			return "", nil
		}
		trimmed = detected
	}

	if err := CheckBindAddr(trimmed, allowPublic); err != nil {
		return "", fmt.Errorf("config: refusing to start: %s: %w", EnvSMTPAddr, err)
	}
	return trimmed, nil
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
	return DefaultTailscaleAddrPort(DefaultIMAPPort)
}

// DefaultTailscaleAddrPort scans local network interfaces for an address in
// the Tailscale CGNAT range and returns "ip:port".
func DefaultTailscaleAddrPort(port string) (string, error) {
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
			return net.JoinHostPort(ipNet.IP.String(), port), nil
		}
	}
	return "", fmt.Errorf("no interface address found in 100.64.0.0/10 (is Tailscale up?)")
}

// String redacts AccessClientSecret and AccessCookie.
//
// Without this, Go's default struct formatting prints every field, so a single
// `%+v` or `%v` on a Config in a log line would emit the Access service-token
// secret or a live CF_Authorization session cookie in clear. Relying on a
// comment telling people not to do that is not a control: the next person to
// add a debug line will not read it.
//
// GoString covers %#v for the same reason.
func (c *Config) String() string {
	return c.redacted()
}

// GoString implements fmt.GoStringer so %#v is redacted too.
func (c *Config) GoString() string {
	return c.redacted()
}

func (c *Config) redacted() string {
	if c == nil {
		return "<nil>"
	}
	secret := "<unset>"
	if c.AccessClientSecret != "" {
		secret = "<redacted>"
	}
	cookie := "<unset>"
	if c.AccessCookie != "" {
		cookie = "<redacted>"
	}
	return fmt.Sprintf(
		"config.Config{InboxURL:%q, AccessClientID:%q, AccessClientSecret:%s, AccessCookie:%s, "+
			"IMAPAddr:%q, SMTPAddr:%q, TLSCertFile:%q, TLSKeyFile:%q, LogLevel:%q, AllowPublicBind:%t}",
		c.InboxURL, c.AccessClientID, secret, cookie,
		c.IMAPAddr, c.SMTPAddr, c.TLSCertFile, c.TLSKeyFile, c.LogLevel, c.AllowPublicBind,
	)
}
