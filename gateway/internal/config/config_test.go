// Copyright (c) 2026 Brian Crumrine
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

package config

import (
	"fmt"
	"net"
	"net/url"
	"strings"
	"testing"
)

func TestCheckBindAddr_LoopbackAllowed(t *testing.T) {
	if err := CheckBindAddr("127.0.0.1:993", false); err != nil {
		t.Fatalf("loopback should be allowed: %v", err)
	}
	if err := CheckBindAddr("[::1]:993", false); err != nil {
		t.Fatalf("IPv6 loopback should be allowed: %v", err)
	}
}

func TestCheckBindAddr_TailscaleCGNATAllowed(t *testing.T) {
	cases := []string{
		"100.64.0.1:993",
		"100.100.100.100:993",
		"100.127.255.254:993",
	}
	for _, addr := range cases {
		if err := CheckBindAddr(addr, false); err != nil {
			t.Errorf("CheckBindAddr(%q, false) = %v, want nil", addr, err)
		}
	}
}

func TestCheckBindAddr_PublicIPRefused(t *testing.T) {
	err := CheckBindAddr("1.2.3.4:993", false)
	if err == nil {
		t.Fatal("expected public IP to be refused")
	}
	if !strings.Contains(err.Error(), "AGENTIC_ALLOW_PUBLIC_BIND") {
		t.Errorf("error should mention the override variable, got: %v", err)
	}
}

func TestCheckBindAddr_PublicIPAllowedWithOverride(t *testing.T) {
	if err := CheckBindAddr("1.2.3.4:993", true); err != nil {
		t.Fatalf("public IP with allowPublic=true should be allowed: %v", err)
	}
}

func TestCheckBindAddr_EmptyHostIsPublic(t *testing.T) {
	if err := CheckBindAddr(":993", false); err == nil {
		t.Fatal("expected wildcard bind (all interfaces) to be refused")
	}
	if err := CheckBindAddr(":993", true); err != nil {
		t.Fatalf("wildcard bind with allowPublic=true should be allowed: %v", err)
	}
}

func TestCheckBindAddr_JustOutsideCGNATRange(t *testing.T) {
	// 100.63.255.255 and 100.128.0.0 are just outside 100.64.0.0/10.
	for _, addr := range []string{"100.63.255.255:993", "100.128.0.0:993"} {
		if err := CheckBindAddr(addr, false); err == nil {
			t.Errorf("CheckBindAddr(%q, false) should be refused (outside CGNAT range)", addr)
		}
	}
}

func TestCheckBindAddr_InvalidAddr(t *testing.T) {
	if err := CheckBindAddr("not-a-valid-addr", false); err == nil {
		t.Fatal("expected error for address missing a port")
	}
}

func TestCheckBindAddr_HostnameResolvesToAllowed(t *testing.T) {
	resolve := func(host string) ([]net.IP, error) {
		return []net.IP{net.ParseIP("100.64.5.5")}, nil
	}
	if err := checkBindAddr("myhost.tailnet.ts.net:993", false, resolve); err != nil {
		t.Fatalf("hostname resolving to a Tailscale address should be allowed: %v", err)
	}
}

func TestCheckBindAddr_HostnameResolvesToPublic(t *testing.T) {
	resolve := func(host string) ([]net.IP, error) {
		return []net.IP{net.ParseIP("8.8.8.8")}, nil
	}
	if err := checkBindAddr("evil.example.com:993", false, resolve); err == nil {
		t.Fatal("hostname resolving to a public address should be refused")
	}
}

func TestCheckBindAddr_HostnameResolveFailure(t *testing.T) {
	resolve := func(host string) ([]net.IP, error) {
		return nil, &net.DNSError{Err: "no such host", Name: host}
	}
	if err := checkBindAddr("nonexistent.invalid:993", false, resolve); err == nil {
		t.Fatal("expected resolution failure to be surfaced as an error")
	}
}

func TestIsAllowedBindHost(t *testing.T) {
	tests := []struct {
		ip   string
		want bool
	}{
		{"127.0.0.1", true},
		{"::1", true},
		{"100.64.0.0", true},
		{"100.127.255.255", true},
		{"100.128.0.0", false},
		{"100.63.255.255", false},
		{"1.2.3.4", false},
		{"0.0.0.0", false},
	}
	for _, tt := range tests {
		ip := net.ParseIP(tt.ip)
		if got := IsAllowedBindHost(ip); got != tt.want {
			t.Errorf("IsAllowedBindHost(%s) = %v, want %v", tt.ip, got, tt.want)
		}
	}
}

func TestLoad_MissingRequiredVars(t *testing.T) {
	full := map[string]string{
		EnvInboxURL:           "https://mail.example.com",
		EnvAccessClientID:     "id",
		EnvAccessClientSecret: "secret",
		EnvTLSCert:            "/etc/certs/cert.pem",
		EnvTLSKey:             "/etc/certs/key.pem",
		EnvIMAPAddr:           "127.0.0.1:993",
	}

	for _, missing := range []string{EnvInboxURL, EnvAccessClientID, EnvAccessClientSecret, EnvTLSCert, EnvTLSKey} {
		env := map[string]string{}
		for k, v := range full {
			if k == missing {
				continue
			}
			env[k] = v
		}
		lookup := func(key string) (string, bool) {
			v, ok := env[key]
			return v, ok
		}
		_, err := load(lookup)
		if err == nil {
			t.Errorf("expected error when %s is missing", missing)
			continue
		}
		if !strings.Contains(err.Error(), missing) {
			t.Errorf("error for missing %s should name the variable, got: %v", missing, err)
		}
	}
}

func TestLoad_Success(t *testing.T) {
	env := map[string]string{
		EnvInboxURL:           "https://mail.example.com",
		EnvAccessClientID:     "id",
		EnvAccessClientSecret: "topsecret",
		EnvTLSCert:            "/etc/certs/cert.pem",
		EnvTLSKey:             "/etc/certs/key.pem",
		EnvIMAPAddr:           "100.64.1.2:993",
	}
	lookup := func(key string) (string, bool) {
		v, ok := env[key]
		return v, ok
	}
	cfg, err := load(lookup)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg.InboxURL.String() != "https://mail.example.com" {
		t.Errorf("InboxURL = %s", cfg.InboxURL)
	}
	if cfg.IMAPAddr != "100.64.1.2:993" {
		t.Errorf("IMAPAddr = %s", cfg.IMAPAddr)
	}
	if cfg.LogLevel != DefaultLogLevel {
		t.Errorf("LogLevel = %s, want default %s", cfg.LogLevel, DefaultLogLevel)
	}
}

func TestLoad_RefusesPublicBindAddr(t *testing.T) {
	env := map[string]string{
		EnvInboxURL:           "https://mail.example.com",
		EnvAccessClientID:     "id",
		EnvAccessClientSecret: "topsecret",
		EnvTLSCert:            "/etc/certs/cert.pem",
		EnvTLSKey:             "/etc/certs/key.pem",
		EnvIMAPAddr:           "1.2.3.4:993",
	}
	lookup := func(key string) (string, bool) {
		v, ok := env[key]
		return v, ok
	}
	_, err := load(lookup)
	if err == nil {
		t.Fatal("expected Load to refuse a public bind address")
	}
}

func TestLoad_ErrorDoesNotLeakSecret(t *testing.T) {
	env := map[string]string{
		EnvInboxURL:           "https://mail.example.com",
		EnvAccessClientID:     "id",
		EnvAccessClientSecret: "super-secret-value-should-not-appear",
		EnvTLSCert:            "/etc/certs/cert.pem",
		EnvTLSKey:             "/etc/certs/key.pem",
		EnvIMAPAddr:           "1.2.3.4:993", // triggers the public-bind error path
	}
	lookup := func(key string) (string, bool) {
		v, ok := env[key]
		return v, ok
	}
	_, err := load(lookup)
	if err == nil {
		t.Fatal("expected an error")
	}
	if strings.Contains(err.Error(), "super-secret-value-should-not-appear") {
		t.Fatalf("error text leaked the access secret: %v", err)
	}
}

// Formatting a Config must never emit the Access secret or the session cookie.
// This is a control, not a style preference: before String/GoString existed,
// a single %+v in a debug line would have printed both in clear.
func TestConfigFormattingRedactsSecrets(t *testing.T) {
	u, err := url.Parse("https://worker.example.com")
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	cfg := &Config{
		InboxURL:           u,
		AccessClientID:     "id.access",
		AccessClientSecret: "SUPER-SECRET-TOKEN",
		AccessCookie:       "CF_Authorization=SUPER-SECRET-COOKIE",
		IMAPAddr:           "100.64.0.1:993",
	}
	for _, format := range []string{"%v", "%+v", "%s", "%#v"} {
		got := fmt.Sprintf(format, cfg)
		if strings.Contains(got, "SUPER-SECRET-TOKEN") {
			t.Errorf("%s leaked AccessClientSecret: %s", format, got)
		}
		if strings.Contains(got, "SUPER-SECRET-COOKIE") {
			t.Errorf("%s leaked AccessCookie: %s", format, got)
		}
		if !strings.Contains(got, "<redacted>") {
			t.Errorf("%s did not mark the secrets redacted: %s", format, got)
		}
	}
	// An unset secret should be distinguishable from a redacted one.
	empty := &Config{InboxURL: u}
	if !strings.Contains(fmt.Sprintf("%v", empty), "<unset>") {
		t.Errorf("unset secret should render as <unset>, got %v", empty)
	}
}

// baseSubmissionEnv is a valid config with both submission addresses set,
// so a test can vary one field at a time.
func baseSubmissionEnv() map[string]string {
	return map[string]string{
		EnvInboxURL:           "https://mail.example.com",
		EnvAccessClientID:     "id",
		EnvAccessClientSecret: "topsecret",
		EnvTLSCert:            "/etc/certs/cert.pem",
		EnvTLSKey:             "/etc/certs/key.pem",
		EnvIMAPAddr:           "100.64.1.2:993",
		EnvSMTPAddr:           "100.64.1.2:465",
		EnvSMTPStartTLSAddr:   "100.64.1.2:587",
	}
}

func loadEnv(t *testing.T, env map[string]string) (*Config, error) {
	t.Helper()
	return load(func(key string) (string, bool) {
		v, ok := env[key]
		return v, ok
	})
}

func TestLoad_BothSubmissionListeners(t *testing.T) {
	cfg, err := loadEnv(t, baseSubmissionEnv())
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if cfg.SMTPAddr != "100.64.1.2:465" {
		t.Errorf("SMTPAddr = %q", cfg.SMTPAddr)
	}
	if cfg.SMTPStartTLSAddr != "100.64.1.2:587" {
		t.Errorf("SMTPStartTLSAddr = %q", cfg.SMTPStartTLSAddr)
	}
}

// TestLoad_SubmissionListenersAreIndependentlyOptional: either door can be
// turned off without touching the other, and turning both off must still
// leave a usable IMAP config.
func TestLoad_SubmissionListenersAreIndependentlyOptional(t *testing.T) {
	tests := []struct {
		name         string
		implicit     string
		starttls     string
		wantImplicit string
		wantStartTLS string
	}{
		{"both on", "100.64.1.2:465", "100.64.1.2:587", "100.64.1.2:465", "100.64.1.2:587"},
		{"implicit off", "off", "100.64.1.2:587", "", "100.64.1.2:587"},
		{"starttls off", "100.64.1.2:465", "off", "100.64.1.2:465", ""},
		{"both off", "off", "off", "", ""},
		{"disabled spelling none", "none", "disabled", "", ""},
		{"disabled spelling false", "false", "OFF", "", ""},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			env := baseSubmissionEnv()
			env[EnvSMTPAddr] = tc.implicit
			env[EnvSMTPStartTLSAddr] = tc.starttls

			cfg, err := loadEnv(t, env)
			if err != nil {
				t.Fatalf("load: %v", err)
			}
			if cfg.SMTPAddr != tc.wantImplicit {
				t.Errorf("SMTPAddr = %q, want %q", cfg.SMTPAddr, tc.wantImplicit)
			}
			if cfg.SMTPStartTLSAddr != tc.wantStartTLS {
				t.Errorf("SMTPStartTLSAddr = %q, want %q", cfg.SMTPStartTLSAddr, tc.wantStartTLS)
			}
			// IMAP is unaffected either way; submission must never be able
			// to stop it.
			if cfg.IMAPAddr != "100.64.1.2:993" {
				t.Errorf("IMAPAddr = %q, want it untouched", cfg.IMAPAddr)
			}
		})
	}
}

// TestLoad_SubmissionAddrsHonourThePublicBindInterlock: an addition must
// not become a hole in the one safety check that exists.
func TestLoad_SubmissionAddrsHonourThePublicBindInterlock(t *testing.T) {
	for _, envVar := range []string{EnvSMTPAddr, EnvSMTPStartTLSAddr} {
		t.Run(envVar, func(t *testing.T) {
			env := baseSubmissionEnv()
			env[envVar] = "203.0.113.7:465"

			if _, err := loadEnv(t, env); err == nil {
				t.Fatalf("load accepted a public bind address for %s", envVar)
			} else if !strings.Contains(err.Error(), envVar) {
				t.Errorf("error %q does not name %s", err, envVar)
			}

			// And the override still works, for the operator who means it.
			env[EnvAllowPublicBind] = "true"
			cfg, err := loadEnv(t, env)
			if err != nil {
				t.Fatalf("load with the override: %v", err)
			}
			if cfg.SMTPAddr == "" && cfg.SMTPStartTLSAddr == "" {
				t.Error("both submission listeners are disabled despite the override")
			}
		})
	}
}

func TestConfigRedactionCoversSubmissionAddrs(t *testing.T) {
	cfg, err := loadEnv(t, baseSubmissionEnv())
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	rendered := cfg.String()
	if !strings.Contains(rendered, "100.64.1.2:587") {
		t.Errorf("String() = %q, want it to show the STARTTLS address", rendered)
	}
	if strings.Contains(rendered, "topsecret") {
		t.Errorf("String() = %q leaks the service token secret", rendered)
	}
}
