package entity

type Room struct {
	ID        string
	Group     string
	Order     int
	Permanent bool
	AudioCodec string
	AudioQuality int
}
