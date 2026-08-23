// Copyright (c) 2026 Brian Crumrine
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

package imap

import (
	"strings"

	"github.com/emersion/go-imap/v2"

	"github.com/crumrine/agentic-inbox-imap/gateway/internal/backend"
)

// Bounds on a decoded structure. The Worker applies its own ceilings before
// storing, so these are not the primary defence; they exist because the
// payload is parsed here and a malformed one must cost nothing.
const (
	maxBodyStructureDepth = 16
	maxBodyStructureParts = 512
)

// decodeBodyStructure converts the Worker's precomputed BODYSTRUCTURE into
// go-imap's form, returning nil when the payload cannot be used.
//
// Nil is the ordinary answer, not a failure: the field is absent on every
// message received before the Worker learned to derive it, and the deriver
// returns nothing rather than approximating whenever a message is outside
// what it can represent exactly. Every nil here means the caller falls back
// to reading the raw message, which is the path that already worked.
//
// The decode refuses anything it is not certain of, for the same reason the
// deriver does. A missing structure costs one R2 GET; a wrong one makes a
// client render the wrong part of a message with no way to notice.
//
// # Why this cannot return a partially built tree
//
// go-imap's writer does not validate what it is handed, so three shapes are
// panics rather than errors, and all three are rejected here:
//
//   - a nil Extended on any node, which writeBodyType1part and
//     writeBodyTypeMpart dereference unconditionally;
//   - a multipart with no children, which writeBodyTypeMpart panics on;
//   - a message/rfc822 part, which needs an envelope and a nested structure
//     the payload does not carry. go-imap would silently emit a body-type-1part
//     where the grammar requires a body-type-msg. The deriver refuses these,
//     so this is belt and braces.
func decodeBodyStructure(node *backend.BodyStructureNode) imap.BodyStructure {
	if node == nil {
		return nil
	}
	if node.Version != backend.BodyStructureVersion {
		// Includes the zero value, which is what a payload missing "v"
		// decodes to. An unrecognised version is ignored whole rather than
		// partially decoded.
		return nil
	}

	parts := 0
	return decodeBodyStructureNode(node, 0, &parts)
}

func decodeBodyStructureNode(node *backend.BodyStructureNode, depth int, parts *int) imap.BodyStructure {
	if depth > maxBodyStructureDepth {
		return nil
	}
	*parts++
	if *parts > maxBodyStructureParts {
		return nil
	}

	// A multipart is identified by having children, not by its type token:
	// a single part's type is an arbitrary lower-cased word, so "multipart"
	// is not a reliable discriminant. This matches the Worker's own test.
	if len(node.Children) > 0 {
		return decodeMultiPart(node, depth, parts)
	}

	// A node claiming to be a multipart without children would panic
	// go-imap's writer. The deriver refuses to store one; refuse to decode
	// one too rather than trusting the payload.
	if strings.EqualFold(node.Type, "multipart") {
		return nil
	}
	return decodeSinglePart(node)
}

func decodeMultiPart(node *backend.BodyStructureNode, depth int, parts *int) imap.BodyStructure {
	if node.Subtype == "" {
		return nil
	}

	children := make([]imap.BodyStructure, 0, len(node.Children))
	for i := range node.Children {
		child := decodeBodyStructureNode(&node.Children[i], depth+1, parts)
		if child == nil {
			// One unusable child makes the whole tree unusable: emitting
			// the rest would silently renumber the parts after it, and a
			// client addresses parts by position.
			return nil
		}
		children = append(children, child)
	}

	return &imap.BodyStructureMultiPart{
		Children: children,
		Subtype:  node.Subtype,
		// Always allocated. A nil Extended is a panic in the writer, not a
		// missing field.
		Extended: &imap.BodyStructureMultiPartExt{
			Params:      node.Params,
			Disposition: decodeDisposition(node.Disposition),
			Language:    node.Language,
			Location:    node.Location,
		},
	}
}

func decodeSinglePart(node *backend.BodyStructureNode) imap.BodyStructure {
	if node.Type == "" || node.Subtype == "" {
		return nil
	}

	// message/rfc822 and message/global need an envelope, a nested
	// structure and a line count that the payload does not carry. Emitting
	// one without them produces a response that does not match the
	// grammar, so fall back and read the message instead.
	if strings.EqualFold(node.Type, "message") &&
		(strings.EqualFold(node.Subtype, "rfc822") || strings.EqualFold(node.Subtype, "global")) {
		return nil
	}

	part := &imap.BodyStructureSinglePart{
		Type:        node.Type,
		Subtype:     node.Subtype,
		Params:      node.Params,
		ID:          node.ID,
		Description: node.Description,
		Encoding:    node.Encoding,
		Size:        node.Size,
		Extended: &imap.BodyStructureSinglePartExt{
			Disposition: decodeDisposition(node.Disposition),
			Language:    node.Language,
			Location:    node.Location,
		},
	}

	// A line count belongs to text/* only. go-imap writes it as an extra
	// field of body-type-text, so attaching it to anything else would
	// produce a malformed response.
	if strings.EqualFold(node.Type, "text") {
		part.Text = &imap.BodyStructureText{NumLines: node.NumLines}
	}
	return part
}

func decodeDisposition(d *backend.BodyStructureDisposition) *imap.BodyStructureDisposition {
	if d == nil || d.Value == "" {
		// go-imap writes NIL for a nil disposition, which is what an
		// absent Content-Disposition means. An empty value would emit a
		// disposition with an empty string instead.
		return nil
	}
	return &imap.BodyStructureDisposition{
		Value:  d.Value,
		Params: d.Params,
	}
}
