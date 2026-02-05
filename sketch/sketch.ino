// C++ code
//
void setup()
{
  pinMode(13, OUTPUT);
}

void loop()
{
  digitalWrite(13, HIGH);
  delay(1); // Wait for 1 millisecond(s)
  digitalWrite(13, LOW);
  delay(1); // Wait for 1 millisecond(s)
}