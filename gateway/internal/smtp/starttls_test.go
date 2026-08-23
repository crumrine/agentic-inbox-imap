// Copyright (c) 2026 Brian Crumrine
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

package smtp

import (
	"strings"
	"testing"
)

// hasAuthCapability looks for an AUTH capability line in an EHLO reply.
// Matching whole lines matters: "AUTH" appears inside other words and a
// naive substring check is how this assertion goes vacuous.
func hasAuthCapability(reply []string) bool {
	for _, line := range reply {
		if len(line) < 4 {
			continue
		}
		cap := strings.ToUpper(strings.TrimSpace(line[4:]))
		if cap == "AUTH" || strings.HasPrefix(cap, "AUTH ") {
			return true
		}
	}
	return false
}

func hasCapability(reply []string, want string) bool {
	for _, line := range reply {
		if len(line) < 4 {
			continue
		}
		cap := strings.ToUpper(strings.TrimSpace(line[4:]))
		if cap == want || strings.HasPrefix(cap, want+" ") {
			return true
		}
	}
	return false
}

// TestSTARTTLSEhloBeforeUpgradeOffersNoAuth is the security-relevant
// assertion on this port. Until the connection is encrypted the server
// must not invite a client to send a password.
func TestSTARTTLSEhloBeforeUpgradeOffersNoAuth(t *testing.T) {
	c, _ := startSTARTTLSClient(t, newFakeBackend())

	reply := c.do("EHLO client.test")
	requireCode(t, reply, 250)

	if !hasCapability(reply, "STARTTLS") {
		t.Errorf("EHLO = %q, want STARTTLS advertised on 587", reply)
	}
	if hasAuthCapability(reply) {
		t.Fatalf("EHLO = %q, advertises AUTH before the connection is encrypted", reply)
	}
}

// TestSTARTTLSCleartextAuthIsRefused: advertising nothing is not enough,
// the command itself has to be refused. go-smtp answers 523 5.7.10 before
// it has even parsed the mechanism, so no credential is read off the wire.
func TestSTARTTLSCleartextAuthIsRefused(t *testing.T) {
	be := newFakeBackend()
	c, _ := startSTARTTLSClient(t, be)

	requireCode(t, c.do("EHLO client.test"), 250)

	reply := c.do("AUTH PLAIN %s", plainAuth(testMailbox, testPassword))
	if got := code(t, reply); got/100 != 5 {
		t.Fatalf("cleartext AUTH = %q, want a 5xx refusal", reply)
	}
	if !strings.Contains(strings.Join(reply, "\n"), "TLS") {
		t.Errorf("cleartext AUTH = %q, want the refusal to say TLS is required", reply)
	}

	be.mu.Lock()
	calls := len(be.authCalls)
	be.mu.Unlock()
	if calls != 0 {
		t.Errorf("the backend was asked to check %d credentials offered in cleartext, want 0", calls)
	}
}

// TestSTARTTLSAuthSucceedsAfterUpgrade is the other half: once encrypted,
// the same credential works.
func TestSTARTTLSAuthSucceedsAfterUpgrade(t *testing.T) {
	be := newFakeBackend()
	c, clientTLS := startSTARTTLSClient(t, be)

	requireCode(t, c.do("EHLO client.test"), 250)
	c.startTLS(clientTLS)

	// RFC 3207: EHLO must be reissued after the upgrade, and go-smtp
	// discards the previous state to force it.
	reply := c.do("EHLO client.test")
	requireCode(t, reply, 250)
	if !hasAuthCapability(reply) {
		t.Fatalf("EHLO after STARTTLS = %q, want AUTH advertised", reply)
	}
	if hasCapability(reply, "STARTTLS") {
		t.Errorf("EHLO after STARTTLS = %q, still offers STARTTLS on an encrypted link", reply)
	}

	requireCode(t, c.do("AUTH PLAIN %s", plainAuth(testMailbox, testPassword)), 235)

	be.mu.Lock()
	calls := append([]string(nil), be.authCalls...)
	be.mu.Unlock()
	if len(calls) != 1 || calls[0] != testMailbox {
		t.Errorf("Authenticate calls = %v, want one for %q", calls, testMailbox)
	}
}

// TestSTARTTLSFullSubmission is the exchange a real client performs on 587,
// end to end over a real go-smtp server and a real TLS handshake.
func TestSTARTTLSFullSubmission(t *testing.T) {
	be := newFakeBackend()
	c, clientTLS := startSTARTTLSClient(t, be)

	requireCode(t, c.do("EHLO client.test"), 250)
	c.startTLS(clientTLS)
	requireCode(t, c.do("EHLO client.test"), 250)
	requireCode(t, c.do("AUTH PLAIN %s", plainAuth(testMailbox, testPassword)), 235)

	requireCode(t, c.do("MAIL FROM:<%s>", testMailbox), 250)
	requireCode(t, c.do("RCPT TO:<a@example.com>"), 250)
	requireCode(t, c.do("DATA"), 354)
	c.write(testMessage + ".\r\n")
	requireCode(t, c.readReply(), 250)

	requireCode(t, c.do("QUIT"), 221)

	call, ok := be.lastSubmit()
	if !ok {
		t.Fatal("the backend was never called")
	}
	if call.mailbox != testMailbox || call.envelopeFrom != testMailbox {
		t.Errorf("submission = %+v", call)
	}
	if len(call.envelopeTo) != 1 || call.envelopeTo[0] != "a@example.com" {
		t.Errorf("envelopeTo = %v", call.envelopeTo)
	}
	if call.body != testMessage {
		t.Errorf("body = %q\nwant   %q", call.body, testMessage)
	}
}

// TestSTARTTLSAndImplicitTLSReachTheBackendIdentically: the two ports are
// two front doors onto one session implementation, not two implementations.
func TestSTARTTLSAndImplicitTLSReachTheBackendIdentically(t *testing.T) {
	implicitBE := newFakeBackend()
	implicit := startRawClient(t, implicitBE)
	authenticate(t, implicit)
	requireCode(t, sendMessage(t, implicit, testMessage, "a@example.com"), 250)

	startTLSBE := newFakeBackend()
	starttls, clientTLS := startSTARTTLSClient(t, startTLSBE)
	requireCode(t, starttls.do("EHLO client.test"), 250)
	starttls.startTLS(clientTLS)
	requireCode(t, starttls.do("EHLO client.test"), 250)
	requireCode(t, starttls.do("AUTH PLAIN %s", plainAuth(testMailbox, testPassword)), 235)
	requireCode(t, sendMessage(t, starttls, testMessage, "a@example.com"), 250)

	a, _ := implicitBE.lastSubmit()
	b, _ := startTLSBE.lastSubmit()

	if a.mailbox != b.mailbox {
		t.Errorf("mailbox differs: %q vs %q", a.mailbox, b.mailbox)
	}
	if a.envelopeFrom != b.envelopeFrom {
		t.Errorf("envelopeFrom differs: %q vs %q", a.envelopeFrom, b.envelopeFrom)
	}
	if strings.Join(a.envelopeTo, ",") != strings.Join(b.envelopeTo, ",") {
		t.Errorf("envelopeTo differs: %v vs %v", a.envelopeTo, b.envelopeTo)
	}
	if a.body != b.body {
		t.Errorf("body differs:\n465: %q\n587: %q", a.body, b.body)
	}
}

// TestSTARTTLSAppliesTheSameSenderCheck confirms the shared session logic
// really is shared, rather than the new door bypassing it.
func TestSTARTTLSAppliesTheSameSenderCheck(t *testing.T) {
	be := newFakeBackend()
	c, clientTLS := startSTARTTLSClient(t, be)

	requireCode(t, c.do("EHLO client.test"), 250)
	c.startTLS(clientTLS)
	requireCode(t, c.do("EHLO client.test"), 250)
	requireCode(t, c.do("AUTH PLAIN %s", plainAuth(testMailbox, testPassword)), 235)

	if got := code(t, c.do("MAIL FROM:<someone-else@example.com>")); got != 550 {
		t.Errorf("MAIL FROM mismatch on 587 = %d, want 550", got)
	}
	if be.submitCount() != 0 {
		t.Errorf("the backend was called %d times, want 0", be.submitCount())
	}
}

func TestSTARTTLSAdvertisesTheSameSize(t *testing.T) {
	c, _ := startSTARTTLSClient(t, newFakeBackend())
	reply := c.do("EHLO client.test")
	requireCode(t, reply, 250)
	if !hasCapability(reply, "SIZE") {
		t.Errorf("EHLO = %q, want SIZE advertised before the upgrade too", reply)
	}
	if !strings.Contains(strings.Join(reply, "\n"), "SIZE 5242880") {
		t.Errorf("EHLO = %q, want the same 5 MiB cap as the other door", reply)
	}
}

// TestImplicitTLSDoorStillRefusesCleartextAndOffersNoStartTLS guards
// against the 465 posture regressing while adding 587.
func TestImplicitTLSDoorStillRefusesCleartextAndOffersNoStartTLS(t *testing.T) {
	// Configured exactly as production does it: no insecure auth.
	c := startRawClient(t, newFakeBackend(), func(o *Options) { o.AllowInsecureAuth = false })

	reply := c.do("EHLO client.test")
	requireCode(t, reply, 250)
	if hasCapability(reply, "STARTTLS") {
		t.Errorf("EHLO on 465 = %q, want no STARTTLS on an implicit-TLS listener", reply)
	}
	if hasAuthCapability(reply) {
		t.Errorf("EHLO on a cleartext 465 connection = %q, want no AUTH", reply)
	}
	if got := code(t, c.do("STARTTLS")); got/100 != 5 {
		t.Errorf("STARTTLS on 465 = %d, want a 5xx", got)
	}
}
